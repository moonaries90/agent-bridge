/**
 * ZCode Adapter — ZCode Protocol (app-server --stdio) Mode
 *
 * Spawns `zcode app-server --stdio` and drives it over newline-delimited
 * JSON-RPC. This is the same "headless stdio" shape as KimiAdapter, but talks
 * the ZCode Protocol instead of ACP.
 *
 * Why not a WS proxy like CodexAdapter? ZCode's app-server only accepts stdio
 * (no `--listen`), and the ZCode TUI has no `--remote` attach mode. So we
 * cannot run the "TUI middleman" architecture codex uses. We drive the agent
 * directly over stdio, like kimi.
 *
 * The win over kimi: ZCode emits a much richer `session/event` stream —
 * `part.delta` (token-level), `tool.updated` (tool-call boundary),
 * `turn.started`/`turn.completed` — which makes the [STATUS] flush reliable
 * (kimi's ACP `session/update` has no clean "speaking → acting" boundary, so
 * its [STATUS] often never flushes).
 *
 * Wire format: newline-delimited JSON, envelope is JSON-RPC 2.0 *without* the
 * `jsonrpc` field and `.strict()` (extra keys are rejected). See
 * zcode-server.cjs zcodeProtocolMessageSchema union:
 *   request:       { id, method, params?, trace? }
 *   response:      { id, result }
 *   notification:  { method, params?, trace? }
 *   error:         { id, error: { code, message, data? } }
 *
 * Key method mapping:
 *   start()         → session/create  (returns sessionId)
 *   injectMessage() → session/send    (async; turn ends via turn.completed event)
 *   part.delta      → accumulate → emit agentMessage on turn.completed
 *   tool.updated    → flush accumulated text as [STATUS] (speaking→acting boundary)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StateDirResolver } from "./state-dir";
import type { BridgeMessage } from "./types";

// ── ZCode Protocol envelope types ───────────────────────────────────────────
// NOTE: deliberately omit `jsonrpc` — the ZCode schema is .strict() and rejects it.

interface ZcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface ZcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface ZcResponse {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

type ZcMessage = ZcRequest | ZcResponse | ZcNotification;

interface PendingRequest {
  resolve: (response: ZcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Workspace identity for session/create. ZCode requires all three fields
// (workspacePath, workspaceKey are non-empty). workspaceIdentity is optional.
interface WorkspaceRef {
  workspacePath: string;
  workspaceKey: string;
  workspaceIdentity?: string;
}

export class ZcodeAdapter extends EventEmitter {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  // A single ZCode turn (session/send) can run a long build/test suite.
  // Same rationale as KimiAdapter.TURN_TIMEOUT_MS — backstop only.
  private static readonly TURN_TIMEOUT_MS = Number(process.env.ZCODE_TURN_TIMEOUT_MS) || 7_200_000;

  private child: ChildProcess | null = null;
  private stopped = false;
  private suppressExitEvent = false;
  private readonly logFile: string;

  private nextRequestId = 1;
  private pendingRequests = new Map<number | string, PendingRequest>();

  // ZCode session state
  private sessionId: string | null = null;
  private initialized = false;

  // Turn state
  turnInProgress = false;
  // Final assistant message text accumulated from part.delta during the turn.
  private messageBuffer: string[] = [];
  // [STATUS] buffer: same accumulation as messageBuffer, but flushed at
  // tool-call boundaries (tool.updated) as a [STATUS] message to Claude.
  // Not cleared on flush — the final turn.completed message stays complete.
  private statusBuffer: string[] = [];
  private currentSendId: number | string | null = null;

  constructor(logFile = new StateDirResolver().logFile) {
    super();
    this.logFile = logFile;
  }

  // ── Public surface (matches CodexAdapter/KimiAdapter interface) ──────────

  get appServerUrl(): string {
    return "zcode://app-server";
  }

  get proxyUrl(): string {
    // ZCode has no proxy — driven directly over stdio. Placeholder for status.
    return "(direct stdio)";
  }

  get activeThreadId(): string | null {
    return this.sessionId;
  }

  /**
   * Start: spawn `zcode app-server --stdio`, create a session.
   */
  async start(): Promise<void> {
    this.stopped = false;

    const zcodeBin = process.env.ZCODE_BIN ??
      join(homedir(), ".zcode/server/agents/glm/zcode-agent");
    const workDir = process.env.ZCODE_WORK_DIR ?? process.cwd();
    const extraArgs = (process.env.ZCODE_APP_SERVER_ARGS ?? "").split(/\s+/).filter(Boolean);
    const args = ["app-server", "--stdio", ...extraArgs];
    this.log(`Spawning zcode app-server subprocess: ${zcodeBin} ${args.join(" ")}`);

    this.child = spawn(zcodeBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workDir,
      env: { ...process.env },
    });

    this.child.on("error", (err) => {
      this.log(`zcode app-server spawn error: ${err.message}`);
      this.emit("error", err);
    });

    this.child.on("exit", (code, signal) => {
      this.log(`zcode app-server exited (code=${code}, signal=${signal})`);
      this.cleanupPendingRequests(new Error(`zcode app-server exited (code=${code})`));
      // If a turn was in progress when the child died, the turn will never
      // complete via the normal turn.completed event. Emit turnCompleted so
      // the daemon unblocks — otherwise it waits forever ("ZCode is working")
      // and rejects all further injections. Surface a diagnostic agentMessage
      // so Claude knows why the turn ended abruptly.
      if (this.turnInProgress) {
        const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        this.log(`Turn aborted: zcode process died mid-turn (${reason})`);
        this.emit("agentMessage", {
          id: `zcode_crash_${Date.now()}`,
          source: "codex",
          content: `[STATUS] ⚠️ ZCode process exited unexpectedly (${reason}) during this turn. The turn was aborted. You may want to retry or check ZCode status.`,
          timestamp: Date.now(),
        } satisfies BridgeMessage);
        this.turnInProgress = false;
        this.currentSendId = null;
        this.messageBuffer = [];
        this.statusBuffer = [];
        this.emit("turnCompleted");
      }
      if (!this.suppressExitEvent) {
        this.emit("exit", code);
      }
    });

    // Read stdout line-by-line (newline-delimited JSON envelope)
    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout });
      rl.on("line", (line) => this.handleMessage(line));
    }

    // Log stderr for debugging
    if (this.child.stderr) {
      const rl = createInterface({ input: this.child.stderr });
      rl.on("line", (line) => this.log(`[zcode] ${line}`));
    }

    // ZCode app-server has no separate initialize handshake at the wire level
    // (it accepts requests immediately). Create a session to get a sessionId.
    await this.createSession();

    this.log("ZCode adapter ready");
    this.emit("ready", this.sessionId ?? "unknown");
    // No TUI — emit tuiConnected so daemon's TuiConnectionState allows injection
    // (canReply() requires tuiConnected === true).
    this.emit("tuiConnected", 1);
  }

  /**
   * Inject a message into ZCode as a new turn via session/send.
   * Returns true if sent. The turn completes when the turn.completed
   * session/event arrives (handled in handleSessionEvent).
   */
  injectMessage(text: string): boolean {
    if (!this.sessionId) {
      this.log("Cannot inject: no active session");
      return false;
    }
    if (!this.child?.stdin?.writable) {
      this.log("Cannot inject: zcode stdin not writable");
      return false;
    }
    if (this.turnInProgress) {
      this.log(`Rejected injection: turn in progress (session ${this.sessionId})`);
      return false;
    }

    this.turnInProgress = true;
    this.messageBuffer = [];
    this.statusBuffer = [];
    this.emit("turnStarted");

    this.log(`Injecting message into ZCode (${text.length} chars)`);

    const id = this.nextRequestId++;
    this.currentSendId = id;

    // session/send returns once the turn is dispatched; the actual turn
    // completion arrives as a turn.completed session/event. We use a long
    // timeout as a backstop against a hung turn.
    const promise = this.sendRequest(
      "session/send",
      {
        sessionId: this.sessionId,
        content: text,
      },
      ZcodeAdapter.TURN_TIMEOUT_MS,
    );

    promise.then((resp) => {
      this.handleSendResponse(resp);
    }).catch((err) => {
      this.log(`session/send failed: ${err.message}`);
      this.turnInProgress = false;
      this.currentSendId = null;
      this.emit("turnCompleted");
    });

    return true;
  }

  /** Disconnect: kill zcode subprocess. */
  disconnect(): void {
    this.stop();
  }

  /** Full stop: kill the zcode process. */
  stop(): void {
    this.stopped = true;
    this.cleanupPendingRequests(new Error("adapter stopped"));
    this.killChild();
  }

  /**
   * Reset the session: kill the current zcode process and spawn a fresh one.
   * Clears ALL context — new session starts blank. Used at phase boundaries
   * when the context window is full. Mirrors KimiAdapter.resetSession.
   */
  async resetSession(): Promise<void> {
    this.log("Resetting ZCode session — killing old process, starting fresh");

    this.cleanupPendingRequests(new Error("session reset"));
    this.suppressExitEvent = true;
    this.killChild();

    await new Promise((resolve) => setTimeout(resolve, 500));

    this.sessionId = null;
    this.initialized = false;
    this.turnInProgress = false;
    this.messageBuffer = [];
    this.statusBuffer = [];
    this.suppressExitEvent = false;

    await this.start();

    this.log(`Session reset complete — new sessionId=${this.sessionId}`);
  }

  private killChild(): void {
    if (this.child) {
      try { this.child.stdin?.end(); } catch {}
      try { this.child.kill("SIGTERM"); } catch {}
      const killTimer = setTimeout(() => {
        try { this.child?.kill("SIGKILL"); } catch {}
      }, 2000);
      this.child.once("exit", () => clearTimeout(killTimer));
      this.child = null;
    }
  }

  // ── ZCode Protocol ──────────────────────────────────────────────────────

  private resolveWorkspace(): WorkspaceRef {
    const workspacePath = process.env.ZCODE_WORK_DIR ?? process.cwd();
    // workspaceKey is an opaque stable identifier for the workspace; default to
    // the absolute path so multiple workspaces don't collide.
    const workspaceKey = process.env.ZCODE_WORKSPACE_KEY ?? workspacePath;
    return { workspacePath, workspaceKey };
  }

  private async createSession(): Promise<void> {
    if (this.sessionId) return;
    const workspace = this.resolveWorkspace();
    const resp = await this.sendRequest(
      "session/create",
      {
        workspace,
        // yolo-equivalent: in headless mode there is no human to approve tool
        // calls. ZCode session modes: build/edit/plan/yolo. "yolo" auto-grants.
        // Override via ZCODE_SESSION_MODE if a tighter mode is desired (the
        // adapter still auto-approves interaction/requestPermission anyway).
        mode: process.env.ZCODE_SESSION_MODE ?? "yolo",
      },
      ZcodeAdapter.REQUEST_TIMEOUT_MS,
    );

    if (resp.error) {
      throw new Error(`ZCode session/create failed: ${resp.error.message}`);
    }

    // sessionId lives at result.session.sessionId per zcodeSessionStateSnapshotSchema.
    const sid = (resp.result?.session as Record<string, unknown> | undefined)?.sessionId;
    if (typeof sid !== "string" || !sid) {
      throw new Error("ZCode session/create returned no sessionId");
    }
    this.sessionId = sid;
    this.initialized = true;
    this.log(`ZCode session created: ${this.sessionId}`);

    // session/subscribe is REQUIRED to receive session/event notifications.
    // Without it, session/send triggers a turn but no turn.started/part.delta/
    // turn.completed notifications are delivered — the adapter would hang
    // waiting for events that never arrive. Verified empirically.
    await this.sendRequest(
      "session/subscribe",
      { sessionId: this.sessionId, deliveryKind: "desktop-continuous", includeSnapshot: false },
      ZcodeAdapter.REQUEST_TIMEOUT_MS,
    );
    this.log(`Subscribed to session events: ${this.sessionId}`);
  }

  // ── Message handling ────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: ZcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log(`Unparseable line from zcode: ${raw.slice(0, 100)}`);
      return;
    }

    // Response (has id, no method) — resolve pending request
    if ("id" in msg && msg.id !== undefined && !("method" in msg)) {
      this.resolveRequest(msg.id, msg as ZcResponse);
      return;
    }

    // Notification (has method, no id) — session/event, state.updated, etc.
    if ("method" in msg && !("id" in msg)) {
      this.handleNotification(msg as ZcNotification);
      return;
    }

    // Request from server (has both id and method) — permission/userInput/etc.
    if ("id" in msg && "method" in msg) {
      this.handleServerRequest(msg as ZcRequest);
      return;
    }
  }

  private handleNotification(msg: ZcNotification): void {
    switch (msg.method) {
      case "session/event":
        this.handleSessionEvent(msg.params);
        break;
      case "state.updated":
        // Workspace/session state revision tick. We don't need to act on it;
        // the session/event stream already carries turn/message deltas.
        break;
      default:
        this.log(`notification: ${msg.method}`);
        break;
    }
  }

  /**
   * Dispatch a ZCode session/event. The event is wrapped:
   *   params = { type, payload, sessionId?, seq?, eventId?, ... }
   * where `type` is one of the zcodeSessionEventSchema discriminators
   * (turn.started, turn.completed, turn.failed, part.delta, tool.updated, ...)
   * and the event-specific data lives under `params.payload`.
   *
   * NOTE: the `type` and `payload` are siblings — do NOT read turn fields
   * (response, error, resultType) directly from `params`; they are under
   * `params.payload`. Verified empirically against the live app-server.
   */
  private handleSessionEvent(params: Record<string, unknown> | undefined): void {
    if (!params) return;
    const type = params.type as string | undefined;
    if (!type) return;
    // Most events nest their data under `payload`. Default to {} so downstream
    // extraction is uniform whether or not payload is present.
    const payload = (params.payload as Record<string, unknown> | undefined) ?? {};

    switch (type) {
      case "turn.started":
        // turnStarted already emitted in injectMessage; nothing extra here.
        break;

      case "model.streaming": {
        // Token-level streaming text from the assistant. Verified empirically:
        // ZCode streams via `model.streaming` (NOT part.delta), with payload:
        //   { assistantMessageId, delta: "<token>", done: bool, kind: "text_delta" }
        // Accumulate delta into both buffers.
        const text = typeof payload.delta === "string" ? payload.delta : "";
        if (text) {
          this.messageBuffer.push(text);
          this.statusBuffer.push(text);
        }
        break;
      }

      case "part.delta": {
        // Fallback: some ZCode versions may emit part.delta. Same accumulation.
        const text = this.extractDeltaText(payload);
        if (text) {
          this.messageBuffer.push(text);
          this.statusBuffer.push(text);
        }
        break;
      }

      case "part.started":
      case "part.upserted": {
        // A part may carry a complete text chunk (non-streaming model, or the
        // initial render). Capture it if it looks like assistant text.
        const text = this.extractPartText(payload);
        if (text) {
          this.messageBuffer.push(text);
          this.statusBuffer.push(text);
        }
        break;
      }

      case "tool.updated":
        // Tool-call boundary: the agent finished "speaking" and is now "acting".
        // This is the reliable signal kimi lacks — flush the accumulated status
        // narration to Claude as a [STATUS] message here.
        this.flushStatus();
        break;

      case "turn.completed": {
        const response = typeof payload.response === "string" ? payload.response : "";
        // Prefer the streamed accumulation; fall back to the turn.completed
        // `payload.response` field if we somehow captured nothing.
        const fullMessage = this.messageBuffer.join("").trim() || response.trim();
        this.log(`Turn completed (resultType=${payload.resultType ?? "unknown"}, message=${fullMessage.length} chars)`);

        // Flush any trailing narration that never hit a tool boundary.
        this.flushStatus();

        if (fullMessage.length > 0) {
          this.emit("agentMessage", {
            id: `zcode_${Date.now()}`,
            source: "codex", // daemon checks source === "codex" — reuse for now
            content: fullMessage,
            timestamp: Date.now(),
          } satisfies BridgeMessage);
        }

        this.turnInProgress = false;
        this.currentSendId = null;
        this.messageBuffer = [];
        this.statusBuffer = [];
        this.emit("turnCompleted");
        break;
      }

      case "turn.failed": {
        const errMsg = payload.error instanceof Object && "message" in payload.error
          ? String((payload.error as Record<string, unknown>).message ?? "unknown")
          : JSON.stringify(payload.error ?? payload).slice(0, 200);
        this.log(`Turn failed: ${errMsg}`);
        this.flushStatus();
        this.turnInProgress = false;
        this.currentSendId = null;
        this.messageBuffer = [];
        this.statusBuffer = [];
        this.emit("turnCompleted");
        break;
      }

      default:
        // message.upserted, permission.requested, checkpoint.created, etc.
        // are handled elsewhere or not needed for bridge forwarding.
        break;
    }
  }

  /** Extract streaming text from a part.delta event params. */
  private extractDeltaText(params: Record<string, unknown>): string {
    // Prefer explicit text/delta fields; fall back to a nested part object.
    const direct =
      (typeof params.text === "string" && params.text) ||
      (typeof params.delta === "string" && params.delta) ||
      "";
    if (direct) return direct;
    const part = params.part as Record<string, unknown> | undefined;
    if (part) {
      if (typeof part.text === "string") return part.text;
      if (typeof part.delta === "string") return part.delta;
    }
    return "";
  }

  /** Extract text from a part.started/part.upserted event params. */
  private extractPartText(params: Record<string, unknown>): string {
    const part = params.part as Record<string, unknown> | undefined;
    if (part) {
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
    }
    if (typeof params.text === "string") return params.text;
    return "";
  }

  private handleSendResponse(resp: ZcResponse): void {
    // session/send response confirms dispatch. Turn completion is signalled by
    // the turn.completed session/event (handled in handleSessionEvent). If the
    // response itself carries an error, surface it and end the turn.
    if (resp.error) {
      this.log(`session/send error: ${resp.error.message}`);
      this.turnInProgress = false;
      this.currentSendId = null;
      this.emit("turnCompleted");
    }
  }

  /**
   * Flush accumulated status narration as a [STATUS] message to Claude.
   * Triggered at tool-call boundaries (tool.updated) — "finished speaking,
   * starting to act". Empty buffer is a no-op, so a flood of tool.updated
   * events only emits on the first one with accumulated text. Does NOT touch
   * messageBuffer, so the final turn.completed message stays complete.
   *
   * This is the reliable counterpart to kimi's unreliable flushStatus — ZCode
   * gives us an explicit tool boundary event instead of relying on ACP
   * session/update's implicit one.
   */
  private flushStatus(): void {
    const text = this.statusBuffer.join("").trim();
    if (!text) return;
    this.statusBuffer = [];
    this.emit("agentMessage", {
      id: `zcode_status_${Date.now()}`,
      source: "codex",
      content: `[STATUS] ${text}`,
      timestamp: Date.now(),
    } satisfies BridgeMessage);
    this.log(`forwarded [STATUS] narration (${text.length} chars)`);
  }

  /**
   * Handle server→client requests (permission prompts, user input, etc.).
   * The bridge is headless — no human to approve — so we auto-grant.
   *
   * ZCode interaction/requestPermission params carry an `options` array; each
   * option has a `response` describing the decision it represents. We pick an
   * "allow" option (explicit allow > first) and echo its decision. An empty
   * result would be treated as a denial.
   */
  private handleServerRequest(req: ZcRequest): void {
    if (req.method === "interaction/requestPermission") {
      const params = req.params as
        | { options?: Array<{ response?: Record<string, unknown>; optionId?: string; kind?: string }> }
        | undefined;
      const options = Array.isArray(params?.options) ? params.options : [];
      const pick =
        options.find((o) => o?.response?.decision === "allow") ??
        options.find((o) => /allow/i.test(`${o?.kind ?? ""} ${o?.optionId ?? ""}`)) ??
        options[0];
      this.log(
        `Server request: interaction/requestPermission (id=${req.id}) — options=${options.length} → granting decision=${pick?.response?.decision ?? "(first)"}`,
      );
      this.sendRaw({
        id: req.id,
        result: pick?.response ?? { decision: "allow" },
      });
      return;
    }

    if (req.method === "interaction/requestUserInput") {
      // No human in headless mode. Echo back an empty string to avoid blocking.
      this.log(`Server request: interaction/requestUserInput (id=${req.id}) — auto-empty`);
      this.sendRaw({ id: req.id, result: { value: "" } });
      return;
    }

    if (req.method === "interaction/requestProviderRuntimeHeaders") {
      // No extra provider headers needed; return empty map.
      this.log(`Server request: interaction/requestProviderRuntimeHeaders (id=${req.id}) — empty`);
      this.sendRaw({ id: req.id, result: { headers: {} } });
      return;
    }

    this.log(`Server request: ${req.method} (id=${req.id}) — auto-approving (empty result)`);
    this.sendRaw({ id: req.id, result: {} });
  }

  // ── Transport ───────────────────────────────────────────────────────────

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ZcResponse> {
    const id = this.nextRequestId++;
    const request: ZcRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout (${timeoutMs}ms): ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.sendRaw(request);
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Send failed for ${method}: ${err.message}`));
      }
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.sendRaw({ method, params });
  }

  /**
   * Write a ZCode envelope to stdin. Deliberately omits `jsonrpc` — the ZCode
   * schema is .strict() and rejects the standard JSON-RPC field.
   */
  private sendRaw(msg: unknown): void {
    if (!this.child?.stdin?.writable) {
      throw new Error("zcode stdin not writable");
    }
    const line = JSON.stringify(msg);
    this.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  private resolveRequest(id: number | string, resp: ZcResponse): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      this.log(`Unmatched response id=${id}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);
    pending.resolve(resp);
  }

  private cleanupPendingRequests(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  // ── Logging ─────────────────────────────────────────────────────────────

  private log(msg: string): void {
    const line = `[${new Date().toISOString()}] [ZcodeAdapter] ${msg}\n`;
    process.stderr.write(line);
    try { appendFileSync(this.logFile, line); } catch {}
  }
}
