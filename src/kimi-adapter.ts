/**
 * Kimi Adapter — ACP (Agent Client Protocol) Mode
 *
 * Spawns `kimi acp` and drives it via JSON-RPC 2.0 over stdin/stdout.
 * This is a drop-in replacement for CodexAdapter: same EventEmitter surface,
 * so daemon.ts can switch between Codex and Kimi via AGENTBRIDGE_PEER env var.
 *
 * ACP protocol ref: https://agentclientprotocol.com/
 * Wire format: newline-delimited JSON-RPC 2.0 (one object per line).
 *
 * Key method mapping:
 *   start()           → initialize + session/new
 *   injectMessage()   → session/prompt (blocks until turn end)
 *   session/update    → agent_message_chunk accumulated → emit agentMessage on turn end
 *   session/prompt response → stopReason → emit turnCompleted
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { StateDirResolver } from "./state-dir";
import type { BridgeMessage } from "./types";

// ACP JSON-RPC types
interface AcpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface AcpResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface AcpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type AcpMessage = AcpRequest | AcpResponse | AcpNotification;

// Pending request tracker
interface PendingRequest {
  resolve: (response: AcpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class KimiAdapter extends EventEmitter {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  // A single Kimi turn (session/prompt) can legitimately run a long build/test
  // suite — sometimes hours. Default 2h; override via KIMI_TURN_TIMEOUT_MS (ms).
  // This is only a backstop against a genuinely hung turn, NOT a normal cap.
  private static readonly TURN_TIMEOUT_MS = Number(process.env.KIMI_TURN_TIMEOUT_MS) || 7_200_000;

  private child: ChildProcess | null = null;
  private stopped = false;
  private suppressExitEvent = false;
  private readonly logFile: string;

  private nextRequestId = 1;
  private pendingRequests = new Map<number | string, PendingRequest>();

  // ACP session state
  private sessionId: string | null = null;
  private initialized = false;
  private initializing = false;

  // Turn state
  turnInProgress = false;
  private messageBuffer: string[] = [];
  // 旁白缓冲：与 messageBuffer 并行累积 agent_message_chunk，在工具调用边界作为 [STATUS]
  // 转发给 Claude；不动 messageBuffer，轮末最终消息仍完整。
  private statusBuffer: string[] = [];
  private thoughtBuffer: string[] = [];
  private currentPromptId: number | string | null = null;

  constructor(logFile = new StateDirResolver().logFile) {
    super();
    this.logFile = logFile;
  }

  // ── Public surface (matches CodexAdapter interface) ──────────

  get appServerUrl(): string {
    return "acp://kimi";
  }

  get proxyUrl(): string {
    // Kimi has no proxy — it's driven directly over stdio.
    // Return a placeholder for status display.
    return "(direct stdio)";
  }

  get activeThreadId(): string | null {
    return this.sessionId;
  }

  /**
   * Start: spawn `kimi acp`, do ACP initialize + session/new.
   */
  async start(): Promise<void> {
    this.stopped = false;

    const kimiBin = process.env.KIMI_BIN ?? "/Users/lji/.kimi-code/bin/kimi";
    const workDir = process.env.KIMI_WORK_DIR ?? process.cwd();
    // Extra args appended to `kimi acp`, e.g. "--yolo" (auto-approve all actions)
    // or "--auto" (auto permission mode). Headless ACP has no human approver, so
    // without one of these kimi's internal permission gate blocks Bash/tool calls.
    const extraAcpArgs = (process.env.KIMI_ACP_ARGS ?? "").split(/\s+/).filter(Boolean);
    const acpArgs = ["acp", ...extraAcpArgs];
    this.log(`Spawning kimi acp subprocess: ${kimiBin} ${acpArgs.join(" ")}`);

    this.child = spawn(kimiBin, acpArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workDir,
      env: { ...process.env },
    });

    this.child.on("error", (err) => {
      this.log(`kimi acp spawn error: ${err.message}`);
      this.emit("error", err);
    });

    this.child.on("exit", (code, signal) => {
      this.log(`kimi acp exited (code=${code}, signal=${signal})`);
      this.cleanupPendingRequests(new Error(`kimi acp exited (code=${code})`));
      // During resetSession, the exit is expected — don't emit it to daemon
      if (!this.suppressExitEvent) {
        this.emit("exit", code);
      }
    });

    // Read stdout line-by-line (ACP is newline-delimited JSON-RPC)
    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout });
      rl.on("line", (line) => this.handleMessage(line));
    }

    // Log stderr for debugging
    if (this.child.stderr) {
      const rl = createInterface({ input: this.child.stderr });
      rl.on("line", (line) => this.log(`[kimi] ${line}`));
    }

    // ACP handshake: initialize → initialized notification → session/new
    await this.initialize();
    await this.createSession();

    this.log("Kimi adapter ready");
    this.emit("ready", this.sessionId ?? "unknown");
    // Kimi has no TUI — emit tuiConnected so daemon's TuiConnectionState
    // allows injection (canReply() requires tuiConnected === true).
    this.emit("tuiConnected", 1);
  }

  /**
   * Inject a message into Kimi as a new turn via session/prompt.
   * Returns true if sent. The response arrives as session/update notifications,
   * and the turn completes when session/prompt response arrives.
   */
  injectMessage(text: string): boolean {
    if (!this.sessionId) {
      this.log("Cannot inject: no active session");
      return false;
    }
    if (!this.child?.stdin?.writable) {
      this.log("Cannot inject: kimi stdin not writable");
      return false;
    }
    if (this.turnInProgress) {
      this.log(`Rejected injection: turn in progress (session ${this.sessionId})`);
      return false;
    }

    this.turnInProgress = true;
    this.messageBuffer = [];
    this.statusBuffer = [];
    this.thoughtBuffer = [];
    this.emit("turnStarted");

    this.log(`Injecting message into Kimi (${text.length} chars)`);

    const id = this.nextRequestId++;
    this.currentPromptId = id;

    // Set up the pending request — resolves when session/prompt response arrives
    const promise = this.sendRequest(
      "session/prompt",
      {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      },
      KimiAdapter.TURN_TIMEOUT_MS,
    );

    // Handle the response asynchronously (turn completed)
    promise.then((resp) => {
      this.handlePromptResponse(resp);
    }).catch((err) => {
      this.log(`session/prompt failed: ${err.message}`);
      this.turnInProgress = false;
      this.currentPromptId = null;
      this.emit("turnCompleted");
    });

    return true;
  }

  /** Disconnect: kill kimi subprocess. */
  disconnect(): void {
    this.stop();
  }

  /** Full stop: kill the kimi process. */
  stop(): void {
    this.stopped = true;
    this.cleanupPendingRequests(new Error("adapter stopped"));
    this.killChild();
  }

  /**
   * Reset the session: kill the current kimi process and spawn a fresh one.
   *
   * This clears ALL context — the new kimi acp process starts with a blank
   * session. Used when the context window is getting full and you want to
   * start a new phase with clean state.
   *
   * The `suppressExitEvent` flag prevents the child's exit from triggering
   * daemon-level crash handling — we know it's intentional.
   */
  async resetSession(): Promise<void> {
    this.log("Resetting Kimi session — killing old process, starting fresh");

    // Kill the old child WITHOUT setting stopped=true (we're about to restart)
    this.cleanupPendingRequests(new Error("session reset"));
    this.suppressExitEvent = true;
    this.killChild();

    // Wait a moment for the old process to fully exit
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Spawn a fresh process and redo the ACP handshake
    this.sessionId = null;
    this.initialized = false;
    this.turnInProgress = false;
    this.messageBuffer = [];
    this.statusBuffer = [];
    this.thoughtBuffer = [];
    this.suppressExitEvent = false;

    await this.start();

    this.log(`Session reset complete — new sessionId=${this.sessionId}`);
  }

  /** Kill the child process (internal helper shared by stop and resetSession). */
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

  // ── ACP Protocol ──────────────────────────────────────────────

  private async initialize(): Promise<void> {
    if (this.initialized || this.initializing) return;
    this.initializing = true;

    const resp = await this.sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "agentbridge", version: "0.1.6" },
      clientCapabilities: {},
    }, KimiAdapter.REQUEST_TIMEOUT_MS);

    if (resp.error) {
      throw new Error(`ACP initialize failed: ${resp.error.message}`);
    }

    // Send initialized notification (LSP-style handshake completion)
    this.sendNotification("notifications/initialized", {});
    this.initialized = true;
    this.initializing = false;
    this.log("ACP initialized");
  }

  private async createSession(): Promise<void> {
    const workDir = process.env.KIMI_WORK_DIR ?? process.cwd();
    const resp = await this.sendRequest("session/new", {
      cwd: workDir,
      mcpServers: [],
    }, KimiAdapter.REQUEST_TIMEOUT_MS);

    if (resp.error) {
      throw new Error(`ACP session/new failed: ${resp.error.message}`);
    }

    this.sessionId = resp.result?.sessionId as string ?? null;
    if (!this.sessionId) {
      throw new Error("ACP session/new returned no sessionId");
    }
    this.log(`ACP session created: ${this.sessionId}`);
  }

  // ── Message handling ──────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: AcpMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log(`Unparseable line from kimi: ${raw.slice(0, 100)}`);
      return;
    }

    // Response (has id, no method) — resolve pending request
    if ("id" in msg && msg.id !== undefined && !("method" in msg)) {
      this.resolveRequest(msg.id, msg as AcpResponse);
      return;
    }

    // Notification (has method, no id) — handle session/update etc.
    if ("method" in msg && !("id" in msg)) {
      this.handleNotification(msg as AcpNotification);
      return;
    }

    // Request from server (has both id and method) — e.g. approval requests
    if ("id" in msg && "method" in msg) {
      this.handleServerRequest(msg as AcpRequest);
      return;
    }
  }

  private handleNotification(msg: AcpNotification): void {
    if (msg.method === "session/update") {
      this.handleSessionUpdate(msg.params);
    }
  }

  private handleSessionUpdate(params: Record<string, unknown> | undefined): void {
    if (!params) return;
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return;

    // ACP v1 structure: params.update.sessionUpdate = "agent_message_chunk"
    //                   params.update.content = { type: "text", text: "..." }
    const type = (update.sessionUpdate ?? update.type) as string;
    const content = update.content as Record<string, unknown> | undefined;

    switch (type) {
      case "agent_message_chunk": {
        // content is { type: "text", text: "token" } OR update.text directly
        const text = (content?.text as string) ?? (update.text as string);
        if (text) {
          this.messageBuffer.push(text);
          this.statusBuffer.push(text);
          this.log(`message chunk: ${text.slice(0, 60)}`);
        }
        break;
      }
      case "agent_thought_chunk": {
        const thought = (content?.text as string) ?? (update.thought as string);
        if (thought) {
          this.thoughtBuffer.push(thought);
        }
        break;
      }
      // tool_call / file_change / command 等：Kimi 说完一段开始动手 → 把累积旁白作为 [STATUS] 转给 Claude
      default:
        this.flushStatus();
        this.log(`session/update type=${type}`);
        break;
    }
  }

  private handlePromptResponse(resp: AcpResponse): void {
    const stopReason = resp.result?.stopReason as string ?? "unknown";
    const fullMessage = this.messageBuffer.join("");

    this.log(`Turn completed (stopReason=${stopReason}, message=${fullMessage.length} chars)`);

    // Emit the assembled agent message if non-empty
    if (fullMessage.length > 0) {
      this.emit("agentMessage", {
        id: `kimi_${Date.now()}`,
        source: "codex", // daemon checks source === "codex" — reuse for now
        content: fullMessage,
        timestamp: Date.now(),
      } satisfies BridgeMessage);
    }

    this.turnInProgress = false;
    this.currentPromptId = null;
    this.messageBuffer = [];
    this.statusBuffer = [];
    this.thoughtBuffer = [];
    this.emit("turnCompleted");
  }

  /**
   * 把累积的 Kimi 旁白（agent_message_chunk）作为一条 [STATUS] 消息转给 Claude，
   * 在工具调用边界触发（"说完就动手"）。空缓冲为 no-op，所以 tool_call_update 洪泛
   * 只会触发首条、其余空转。不动 messageBuffer，轮末最终消息仍完整。
   */
  private flushStatus(): void {
    const text = this.statusBuffer.join("").trim();
    if (!text) return;
    this.statusBuffer = [];
    this.emit("agentMessage", {
      id: `kimi_status_${Date.now()}`,
      source: "codex",
      content: `[STATUS] ${text}`,
      timestamp: Date.now(),
    } satisfies BridgeMessage);
    this.log(`forwarded [STATUS] narration (${text.length} chars)`);
  }

  /**
   * Handle server→client requests (permission prompts, tool calls, etc.).
   * The bridge is headless — there is no human to approve — so we auto-grant.
   *
   * For ACP `session/request_permission` the client MUST reply with a valid
   * outcome that selects one of the offered optionIds. An empty `{}` result is
   * treated by the agent as a rejection (this is why Bash was being blocked even
   * with `kimi acp --yolo`: in ACP mode the *client* is the approver). We pick an
   * "allow" option (persistent > once > anything allow-ish) and echo its optionId.
   */
  private handleServerRequest(req: AcpRequest): void {
    if (req.method === "session/request_permission") {
      const params = req.params as
        | { options?: Array<{ optionId?: string; name?: string; kind?: string }> }
        | undefined;
      const options = Array.isArray(params?.options) ? params.options : [];
      const pick =
        options.find((o) => o?.kind === "allow_always") ??
        options.find((o) => o?.kind === "allow_once") ??
        options.find((o) =>
          /allow|approve|yes|grant/i.test(`${o?.optionId ?? ""} ${o?.name ?? ""} ${o?.kind ?? ""}`),
        ) ??
        options[0];
      this.log(
        `Server request: session/request_permission (id=${req.id}) — options=${JSON.stringify(options)} → granting optionId=${pick?.optionId}`,
      );
      this.sendRaw({
        jsonrpc: "2.0",
        id: req.id,
        result: pick?.optionId
          ? { outcome: { outcome: "selected", optionId: pick.optionId } }
          : { outcome: { outcome: "cancelled" } },
      });
      return;
    }

    this.log(`Server request: ${req.method} (id=${req.id}) — auto-approving (empty result)`);
    this.sendRaw({ jsonrpc: "2.0", id: req.id, result: {} });
  }

  // ── Transport ─────────────────────────────────────────────────

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<AcpResponse> {
    const id = this.nextRequestId++;
    const request: AcpRequest = { jsonrpc: "2.0", id, method, params };

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
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  private sendRaw(msg: unknown): void {
    if (!this.child?.stdin?.writable) {
      throw new Error("kimi stdin not writable");
    }
    const line = JSON.stringify(msg);
    this.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  private resolveRequest(id: number | string, resp: AcpResponse): void {
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

  // ── Logging ──────────────────────────────────────────────────

  private log(msg: string): void {
    const line = `[${new Date().toISOString()}] [KimiAdapter] ${msg}\n`;
    process.stderr.write(line);
    try { appendFileSync(this.logFile, line); } catch {}
  }
}
