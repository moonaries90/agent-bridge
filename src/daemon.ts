#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { CodexAdapter } from "./codex-adapter";
import { KimiAdapter } from "./kimi-adapter";
import { ZcodeAdapter } from "./zcode-adapter";

// Peer selection: "codex" (default), "kimi", or "zcode"
const AGENTBRIDGE_PEER = (process.env.AGENTBRIDGE_PEER ?? "codex").toLowerCase();
import {
  buildBridgeContractReminder,
  buildReplyRequiredInstruction,
  StatusBuffer,
  classifyMessage,
  type FilterMode,
} from "./message-filter";
import { TuiConnectionState } from "./tui-connection-state";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import { CLOSE_CODE_REPLACED } from "./control-protocol";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "./control-protocol";
import type { BridgeMessage } from "./types";
import { buildControllerKickoff, formatControllerInjection } from "./controller-injection";

interface ControlSocketData {
  clientId: number;
  attached: boolean;
}

const stateDir = new StateDirResolver();
stateDir.ensure();
const configService = new ConfigService();
const config = configService.loadOrDefault();

const CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.codex.appPort), 10);
const CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.codex.proxyPort), 10);
const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
const CLAUDE_DISCONNECT_GRACE_MS = 5_000;
const MAX_BUFFERED_MESSAGES = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
const FILTER_MODE: FilterMode =
  (process.env.AGENTBRIDGE_FILTER_MODE as FilterMode) === "full" ? "full" : "filtered";
const IDLE_SHUTDOWN_MS = parseInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000), 10);
const ATTENTION_WINDOW_MS = parseInt(process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ?? String(config.turnCoordination.attentionWindowSeconds * 1000), 10);

const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

// Adapter selection: create the appropriate peer adapter based on AGENTBRIDGE_PEER.
// All adapters implement the same EventEmitter surface (start/stop/disconnect/
// injectMessage + agentMessage/turnStarted/turnCompleted/ready events).
const codex = AGENTBRIDGE_PEER === "kimi"
  ? (new KimiAdapter(stateDir.logFile) as unknown as CodexAdapter)
  : AGENTBRIDGE_PEER === "zcode"
    ? (new ZcodeAdapter(stateDir.logFile) as unknown as CodexAdapter)
    : new CodexAdapter(CODEX_APP_PORT, CODEX_PROXY_PORT, stateDir.logFile, [], process.env.AGENTBRIDGE_WORK_DIR);
const peerName = AGENTBRIDGE_PEER === "kimi"
  ? "Kimi"
  : AGENTBRIDGE_PEER === "zcode"
    ? "ZCode"
    : "Codex";
const attachCmd = AGENTBRIDGE_PEER === "kimi"
  ? "(kimi acp — managed by daemon directly)"
  : AGENTBRIDGE_PEER === "zcode"
    ? "(zcode app-server --stdio — managed by daemon directly)"
    : `codex --enable tui_app_server --remote ${codex.proxyUrl}`;

// ── Controller-side middleman (codex-zcode / codex-kimi) ─────────────
// When the CONTROLLER is Codex (not Claude), run a SECOND CodexAdapter that
// proxies the controller's Codex TUI ↔ its own app-server. This lets the daemon
// inject the peer's replies as real `turn/start` turns directly into the
// controller's thread — so they appear in context in real time, with NO
// get_messages polling (Codex's MCP client never surfaces server-pushed
// notifications into context). SEND stays explicit via the `reply` MCP tool;
// only RECEIVE switches from polling to turn injection.
const CONTROLLER_IS_CODEX = (process.env.AGENTBRIDGE_CONTROLLER ?? "").toLowerCase() === "codex";
// Name the controller side as seen BY THE PEER. The daemon was written
// Claude-first, so peer-facing notices hardcoded "Claude"; when Codex is the
// controller (codex-zcode / codex-kimi) the peer must be told "Codex" instead,
// otherwise the peer greets the wrong agent ("Hi Claude!").
const controllerName = CONTROLLER_IS_CODEX ? "Codex" : "Claude";
// Reminders appended to every controller→peer message, labeled with the actual
// controller + peer names (so e.g. ZCode is told it works with Codex, not Claude).
const bridgeContractReminder = buildBridgeContractReminder(controllerName, peerName);
const replyRequiredInstruction = buildReplyRequiredInstruction(controllerName);
const CONTROLLER_APP_PORT = parseInt(process.env.AGENTBRIDGE_CONTROLLER_APP_PORT ?? "4720", 10);
const CONTROLLER_PROXY_PORT = parseInt(process.env.AGENTBRIDGE_CONTROLLER_PROXY_PORT ?? "4721", 10);

// Build the `-c mcp_servers.agentbridge.*` overrides for the controller Codex's
// app-server, so the controller agent gets the `reply` tool WITHOUT polluting
// the global ~/.codex/config.toml. Mirrors the env table cli/codex-zcode.ts used
// to pass to the TUI — but now targets the middleman's app-server (the TUI is a
// thin `--remote` frontend that does NOT load MCP servers itself).
function buildControllerMcpArgs(): string[] {
  const bridgeScript = process.env.AGENTBRIDGE_BRIDGE_SCRIPT;
  if (!bridgeScript) {
    log("AGENTBRIDGE_BRIDGE_SCRIPT not set — controller Codex will have no reply tool");
    return [];
  }
  return [
    "-c", `mcp_servers.agentbridge.command="bun"`,
    "-c", `mcp_servers.agentbridge.args=["run","${bridgeScript}"]`,
    "-c", `mcp_servers.agentbridge.startup_timeout_sec=15`,
    "-c", `mcp_servers.agentbridge.env.AGENTBRIDGE_PEER="${AGENTBRIDGE_PEER}"`,
    "-c", `mcp_servers.agentbridge.env.AGENTBRIDGE_CONTROL_PORT="${CONTROL_PORT}"`,
    "-c", `mcp_servers.agentbridge.env.AGENTBRIDGE_STATE_DIR="${process.env.AGENTBRIDGE_STATE_DIR ?? ""}"`,
    "-c", `mcp_servers.agentbridge.env.AGENTBRIDGE_DAEMON_ENTRY="${process.env.AGENTBRIDGE_DAEMON_ENTRY ?? ""}"`,
    "-c", `mcp_servers.agentbridge.env.AGENTBRIDGE_RESTART_CMD="${process.env.AGENTBRIDGE_RESTART_CMD ?? ""}"`,
  ];
}

const controller: CodexAdapter | null = CONTROLLER_IS_CODEX
  ? new CodexAdapter(CONTROLLER_APP_PORT, CONTROLLER_PROXY_PORT, stateDir.logFile, buildControllerMcpArgs(), process.env.AGENTBRIDGE_WORK_DIR)
  : null;
// Peer content accumulated during the CURRENT peer turn; coalesced into one
// injection on the peer's turnCompleted (avoids one controller turn per
// intermediate peer message).
const controllerTurnBuffer: string[] = [];
// Coalesced messages ready to inject into the controller's thread. Drained when
// the controller is ready and idle (turn injection is rejected mid-turn).
const controllerInjectQueue: string[] = [];
let controllerThreadReady = false;
let controllerKickoffSent = false;
// flushControllerQueue is async (turn/steer awaits its response); guard against
// overlapping runs and remember re-entrant requests so none are lost.
let controllerFlushInFlight = false;
let controllerFlushPending = false;

let controlServer: ReturnType<typeof Bun.serve> | null = null;
let attachedClaude: ServerWebSocket<ControlSocketData> | null = null;
let nextControlClientId = 0;
let nextSystemMessageId = 0;
let codexBootstrapped = false;
let attentionWindowTimer: ReturnType<typeof setTimeout> | null = null;
let inAttentionWindow = false;
let replyRequired = false;
let replyReceivedDuringTurn = false;
let shuttingDown = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let claudeDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
let claudeOnlineNoticeSent = false;
let claudeOfflineNoticeShown = false;
let codexCollaborationKickoffSent = false;
let lastAttachStatusSentTs = 0;
const ATTACH_STATUS_COOLDOWN_MS = 30_000; // Don't re-send status on rapid reattach

const bufferedMessages: BridgeMessage[] = [];

const tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    emitToClaude(
      systemMessage(
        "system_tui_disconnected",
        `⚠️ ${peerName} TUI disconnected (conn #${connId}). ${peerName} is still running in the background — reconnect the TUI to resume.`,
      ),
    );
  },
  onReconnectAfterNotice: (connId) => {
    emitToClaude(
      systemMessage(
        "system_tui_reconnected",
        `✅ ${peerName} TUI reconnected (conn #${connId}). Bridge restored, communication can continue.`,
      ),
    );
    codex.injectMessage(`✅ ${controllerName} is still online, bridge restored. Bidirectional communication can continue.`);
  },
});

const statusBuffer = new StatusBuffer((summary) => forwardPeerContent(summary));

codex.on("turnStarted", () => {
  log(`${peerName} turn started`);
  emitToClaude(
    systemMessage(
      "system_turn_started",
      `⏳ ${peerName} is working on the current task. Wait for completion before sending a reply.`,
    ),
  );
});

codex.on("agentMessage", (msg: BridgeMessage) => {
  if (msg.source !== "codex") return;
  const result = classifyMessage(msg.content, FILTER_MODE);

  // When replyRequired is active, force-forward ALL messages regardless of marker
  if (replyRequired) {
    log(`${peerName} → Claude [${result.marker}/force-forward-reply-required] (${msg.content.length} chars)`);
    replyReceivedDuringTurn = true;
    if (statusBuffer.size > 0) {
      statusBuffer.flush("reply-required message arrived");
    }
    forwardPeerContent(msg);
    return;
  }

  // During attention window, suppress STATUS to give Claude space to respond
  if (inAttentionWindow && result.marker === "status") {
    log(`${peerName} → Claude [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
    statusBuffer.add(msg);
    return;
  }

  log(`${peerName} → Claude [${result.marker}/${result.action}] (${msg.content.length} chars)`);
  switch (result.action) {
    case "forward":
      if (result.marker === "important" && statusBuffer.size > 0) {
        statusBuffer.flush("important message arrived");
      }
      forwardPeerContent(msg);
      // IMPORTANT message — give Claude an attention window to respond
      if (result.marker === "important") {
        startAttentionWindow();
      }
      break;
    case "buffer":
      statusBuffer.add(msg);
      break;
    case "drop":
      break;
  }
});

codex.on("turnCompleted", () => {
  log(`${peerName} turn completed`);
  statusBuffer.flush("turn completed");
  // Coalesce this peer turn's content into a single controller injection.
  flushControllerTurnBuffer();

  // Check if reply was required but Codex didn't send any agentMessage
  if (replyRequired && !replyReceivedDuringTurn) {
    log(`⚠️ Reply was required but ${peerName} did not send any agentMessage`);    emitToClaude(
      systemMessage(
        "system_reply_missing",
        `⚠️ ${peerName} completed the turn without sending a reply (require_reply was set). ${peerName} may not have generated an agentMessage. You may want to retry or rephrase.`,
      ),
    );
  }

  // Reset reply-required state
  replyRequired = false;
  replyReceivedDuringTurn = false;

  emitToClaude(
    systemMessage(
      "system_turn_completed",
      `✅ ${peerName} finished the current turn. You can reply now if needed.`,
    ),
  );
  startAttentionWindow();

  // Retry Claude-online notice if it was deferred while the turn was in progress.
  if (attachedClaude && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
});

codex.on("ready", (threadId: string) => {
  tuiConnectionState.markBridgeReady();
  log(`${peerName} ready — thread ${threadId}`);
  log("Bridge fully operational");

  emitToClaude(
    systemMessage("system_ready", currentReadyMessage()),
  );

  if (attachedClaude && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
});

codex.on("tuiConnected", (connId: number) => {
  tuiConnectionState.handleTuiConnected(connId);
  cancelIdleShutdown();
  log(`${peerName} TUI connected (conn #${connId})`);
  broadcastStatus();
});

codex.on("tuiDisconnected", (connId: number) => {
  tuiConnectionState.handleTuiDisconnected(connId);
  log(`${peerName} TUI disconnected (conn #${connId})`);
  broadcastStatus();
  scheduleIdleShutdown();
});

codex.on("error", (err: Error) => {
  log(`${peerName} error: ${err.message}`);
});

codex.on("exit", (code: number | null) => {
  log(`${peerName} process exited (code ${code})`);
  codexBootstrapped = false;
  statusBuffer.flush("codex exited");
  tuiConnectionState.handleCodexExit();
  clearPendingClaudeDisconnect(`${peerName} process exited`);
  claudeOnlineNoticeSent = false;
  claudeOfflineNoticeShown = false;
  emitToClaude(
    systemMessage(
      "system_codex_exit",
      `⚠️ ${peerName} app-server exited (code ${code ?? "unknown"}). AgentBridge daemon is still running, but the ${peerName} side needs to be restarted.`,
    ),
  );
  broadcastStatus();
});

// ── Controller-side delivery (peer → controller Codex) ───────────────
// In Codex-controller modes we inject peer content as real turns into the
// controller's thread (real-time, no polling). Otherwise (Claude controller) we
// fall back to the control-WS delivery path (push channel / get_messages).
function forwardPeerContent(msg: BridgeMessage) {
  if (controller) {
    // Accumulate within the current peer turn; flushed as ONE injection on the
    // peer's turnCompleted (see flushControllerTurnBuffer). Avoids making the
    // controller run a separate turn per intermediate peer message.
    controllerTurnBuffer.push(msg.content);
  } else {
    emitToClaude(msg);
  }
}

// Coalesce all peer content from the just-finished peer turn into one injection.
function flushControllerTurnBuffer() {
  if (!controller || controllerTurnBuffer.length === 0) return;
  const injection = formatControllerInjection(peerName, controllerTurnBuffer);
  controllerTurnBuffer.length = 0;
  if (injection) {
    controllerInjectQueue.push(injection);
    void flushControllerQueue();
  }
}

// Drain the queue into the controller's thread. When the controller is idle we
// start a new turn (turn/start); when it is busy we STEER the message into its
// active turn (turn/steer) so delivery never waits for the agent to go idle.
// turn/start is rejected mid-turn and steer can race a turn ending, so anything
// not delivered stays queued and is retried on the next ready/turnCompleted.
async function flushControllerQueue() {
  if (!controller || !controllerThreadReady) return;
  if (controllerFlushInFlight) {
    controllerFlushPending = true; // re-run after the current pass
    return;
  }
  controllerFlushInFlight = true;
  try {
    do {
      controllerFlushPending = false;
      while (controllerInjectQueue.length > 0) {
        const text = controllerInjectQueue[0];
        if (controller.turnInProgress) {
          const steered = await controller.steerMessage(text);
          if (!steered) break; // turn ended mid-steer / no active turn — retry later
          controllerInjectQueue.shift();
        } else {
          if (!controller.injectMessage(text)) break; // socket/thread not ready
          controllerInjectQueue.shift();
        }
      }
    } while (controllerFlushPending);
  } finally {
    controllerFlushInFlight = false;
  }
}

if (controller) {
  controller.on("ready", (threadId: string) => {
    controllerThreadReady = true;
    cancelIdleShutdown();
    log(`Controller Codex ready — thread ${threadId}`);
    // Inject the collaboration role as the first visible turn (problem 2).
    // Codex 0.139 also reads the MCP `instructions` field, but a first turn makes
    // the role explicit and visible in the controller's TUI.
    if (!controllerKickoffSent) {
      controllerKickoffSent = true;
      controllerInjectQueue.unshift(buildControllerKickoff(peerName));
    }
    void flushControllerQueue();
  });
  controller.on("turnCompleted", () => {
    void flushControllerQueue();
  });
  controller.on("tuiConnected", (connId: number) => {
    cancelIdleShutdown();
    log(`Controller Codex TUI connected (conn #${connId})`);
    broadcastStatus();
  });
  controller.on("tuiDisconnected", (connId: number) => {
    log(`Controller Codex TUI disconnected (conn #${connId})`);
    scheduleIdleShutdown();
    broadcastStatus();
  });
  controller.on("error", (err: Error) => {
    log(`Controller Codex error: ${err.message}`);
  });
  controller.on("exit", (code: number | null) => {
    controllerThreadReady = false;
    log(`Controller Codex app-server exited (code ${code ?? "unknown"})`);
  });
}

function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") {
        return Response.json(currentStatus());
      }

      if (url.pathname === "/readyz") {
        return Response.json(currentStatus(), { status: codexBootstrapped ? 200 : 503 });
      }

      if (url.pathname === "/ws" && server.upgrade(req, { data: { clientId: 0, attached: false } })) {
        return undefined;
      }

      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960, // 16 minutes — prevent premature idle disconnects
      sendPings: true,
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws: ServerWebSocket<ControlSocketData>, code: number, reason: string) => {
        log(`Frontend socket closed (#${ws.data.clientId}, code=${code}, reason=${reason || "none"}, wasAttached=${attachedClaude === ws})`);
        if (attachedClaude === ws) {
          detachClaude(ws, "frontend socket closed");
        }
      },
      message: (ws: ServerWebSocket<ControlSocketData>, raw) => {
        void handleControlMessage(ws, raw);
      },
    },
  });
}

async function handleControlMessage(ws: ServerWebSocket<ControlSocketData>, raw: string | Buffer) {
  let message: ControlClientMessage;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e: any) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }

  switch (message.type) {
    case "claude_connect":
      attachClaude(ws);
      return;
    case "claude_disconnect":
      detachClaude(ws, "frontend requested disconnect");
      return;
    case "status":
      sendStatus(ws);
      return;
    case "claude_to_codex": {
      if (message.message.source !== "claude") {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Invalid message source",
        });
        return;
      }

      if (!tuiConnectionState.canReply()) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: `${peerName} is not ready. Wait for the session to be established.`,
        });
        return;
      }

      const requireReply = !!message.requireReply;
      let content = message.message.content;

      // Session reset: if the message contains [SESSION_RESET], kill the peer's
      // current session and start a fresh one. This clears all context — use
      // it at phase boundaries when the context window is getting full.
      if (content.includes("[SESSION_RESET]")) {
        log(`Session reset requested by Claude`);
        // Strip the marker from the message — it's a control signal, not content
        content = content.replace(/\[SESSION_RESET\]\s*/g, "").trim();

        if ((AGENTBRIDGE_PEER === "kimi" || AGENTBRIDGE_PEER === "zcode") && typeof (codex as any).resetSession === "function") {
          emitToClaude(systemMessage(
            "system_session_resetting",
            `🔄 Resetting ${peerName} session — killing old process, starting fresh with clean context...`,
          ));
          try {
            await (codex as any).resetSession();
            emitToClaude(systemMessage(
              "system_session_reset",
              `✅ ${peerName} session reset complete. New session: ${codex.activeThreadId}. Previous context is cleared.`,
            ));
            log(`Session reset complete — new sessionId=${codex.activeThreadId}`);
          } catch (err: any) {
            log(`Session reset failed: ${err.message}`);
            emitToClaude(systemMessage(
              "system_session_reset_failed",
              `❌ ${peerName} session reset failed: ${err.message}. Continuing with existing session.`,
            ));
          }
        } else {
          emitToClaude(systemMessage(
            "system_session_reset_unsupported",
            `⚠️ Session reset is only supported in Kimi/ZCode mode (AGENTBRIDGE_PEER=kimi|zcode). Ignoring [SESSION_RESET].`,
          ));
        }

        // If content is empty after stripping the marker, don't inject anything
        if (!content) {
          sendProtocolMessage(ws, {
            type: "claude_to_codex_result",
            requestId: message.requestId,
            success: true,
          });
          return;
        }
      }

      let contentWithReminder = content + "\n\n" + bridgeContractReminder;
      if (requireReply) {
        contentWithReminder += replyRequiredInstruction;
        replyRequired = true;
        replyReceivedDuringTurn = false;
        log(`Reply required flag set for this message`);
      }
      log(`Forwarding Claude → ${peerName} (${content.length} chars, requireReply=${requireReply})`);
      const injected = codex.injectMessage(contentWithReminder);
      if (!injected) {
        const reason = codex.turnInProgress
          ? `${peerName} is busy executing a turn. Wait for it to finish before sending another message.`
          : "Injection failed: no active thread or WebSocket not connected.";
        log(`Injection rejected: ${reason}`);
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: reason,
        });
        return;
      }
      clearAttentionWindow(); // Claude successfully replied, end attention window
      sendProtocolMessage(ws, {
        type: "claude_to_codex_result",
        requestId: message.requestId,
        success: true,
      });
      return;
    }
  }
}

function attachClaude(ws: ServerWebSocket<ControlSocketData>) {
  if (attachedClaude && attachedClaude !== ws && attachedClaude.readyState !== WebSocket.CLOSED) {
    // Replace the existing controller session instead of rejecting the new one.
    //
    // Why replace (not reject): when agentbridge MCP is persisted to
    // config.toml (via --persist / abg init), BOTH the CLI session and the
    // Codex desktop App load their own codex-bridge-mcp child. The user
    // expects to operate from whichever surface is active — so the latest
    // connection wins, and the previous one is politely told to step aside.
    // The replaced side enters a recoverable wait (not permanent disable) and
    // can reclaim the slot when the current holder disconnects.
    log(`Replacing controller #${attachedClaude.data.clientId} with #${ws.data.clientId} (readyState=${attachedClaude.readyState})`);
    try {
      sendBridgeMessage(attachedClaude, systemMessage(
        "system_controller_replaced",
        "↔️ Another controller session (CLI or App) just connected. This side is now standby — it will reconnect automatically when the other side disconnects.",
      ));
    } catch { /* best-effort notification */ }
    try {
      attachedClaude.close(CLOSE_CODE_REPLACED, "replaced by a newer controller session");
    } catch { /* already closing */ }
    attachedClaude = null;
  }

  clearPendingClaudeDisconnect("Claude frontend attached");
  attachedClaude = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`Claude frontend attached (#${ws.data.clientId})`);

  statusBuffer.flush("claude reconnected");
  sendStatus(ws);

  const now = Date.now();
  const isRapidReattach = now - lastAttachStatusSentTs < ATTACH_STATUS_COOLDOWN_MS;

  if (bufferedMessages.length > 0) {
    flushBufferedMessages(ws);
  } else if (!isRapidReattach) {
    // Only send status messages if this is not a rapid reattach (avoid flooding Claude)
    if (tuiConnectionState.canReply()) {
      sendBridgeMessage(ws, systemMessage("system_ready", currentReadyMessage()));
    } else if (codexBootstrapped) {
      sendBridgeMessage(ws, systemMessage("system_waiting", currentWaitingMessage()));
    }
  }

  lastAttachStatusSentTs = now;

  if (tuiConnectionState.canReply() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
}

function detachClaude(ws: ServerWebSocket<ControlSocketData>, reason: string) {
  if (attachedClaude !== ws) return;

  attachedClaude = null;
  ws.data.attached = false;
  log(`Claude frontend detached (#${ws.data.clientId}, ${reason})`);

  scheduleClaudeDisconnectNotification(ws.data.clientId);

  scheduleIdleShutdown();
}

function startAttentionWindow() {
  clearAttentionWindow();
  inAttentionWindow = true;
  statusBuffer.pause();
  log(`Attention window started (${ATTENTION_WINDOW_MS}ms)`);
  attentionWindowTimer = setTimeout(() => {
    attentionWindowTimer = null;
    inAttentionWindow = false;
    statusBuffer.resume();
    log("Attention window ended");
  }, ATTENTION_WINDOW_MS);
}

function clearAttentionWindow() {
  if (attentionWindowTimer) {
    clearTimeout(attentionWindowTimer);
    attentionWindowTimer = null;
  }
  if (inAttentionWindow) {
    statusBuffer.resume();
  }
  inAttentionWindow = false;
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (attachedClaude) return; // still has a client

  const snapshot = tuiConnectionState.snapshot();
  if (snapshot.tuiConnected) return; // TUI still connected

  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    // Re-check before shutting down
    if (attachedClaude || tuiConnectionState.snapshot().tuiConnected) {
      log("Idle shutdown cancelled: client reconnected during grace period");
      return;
    }
    shutdown("idle — no clients connected");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

function clearPendingClaudeDisconnect(reason?: string) {
  if (!claudeDisconnectTimer) return;
  clearTimeout(claudeDisconnectTimer);
  claudeDisconnectTimer = null;
  if (reason) {
    log(`Cleared pending Claude disconnect notification (${reason})`);
  }
}

function scheduleClaudeDisconnectNotification(clientId: number) {
  clearPendingClaudeDisconnect("rescheduled");
  claudeDisconnectTimer = setTimeout(() => {
    claudeDisconnectTimer = null;

    if (attachedClaude) {
      log(
        `Skipping Claude disconnect notification for client #${clientId} because Claude already reconnected`,
      );
      return;
    }

    if (!tuiConnectionState.canReply()) {
      log(
        `Suppressing Claude disconnect notification for client #${clientId} because ${peerName} cannot reply`,
      );
      return;
    }

    if (!claudeOnlineNoticeSent) {
      log(
        `Suppressing Claude disconnect notification for client #${clientId} because Claude was never announced online`,
      );
      return;
    }

    codex.injectMessage(
      `⚠️ ${controllerName} went offline. AgentBridge is still running in the background; it will reconnect automatically when ${controllerName} reopens.`,
    );
    claudeOnlineNoticeSent = false;
    claudeOfflineNoticeShown = true;
    log(`Claude disconnect persisted past grace window (client #${clientId})`);
  }, CLAUDE_DISCONNECT_GRACE_MS);
}

function emitToClaude(message: BridgeMessage) {
  if (attachedClaude && attachedClaude.readyState === WebSocket.OPEN) {
    if (trySendBridgeMessage(attachedClaude, message)) return;
    // Send failed — fall through to buffer
    log("Send to Claude failed, buffering message for retry on reconnect");
  }

  bufferedMessages.push(message);
  if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    bufferedMessages.splice(0, dropped);
    log(`Message buffer overflow: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
  }
}

function trySendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage): boolean {
  try {
    const result = ws.send(JSON.stringify({ type: "codex_to_claude", message } satisfies ControlServerMessage));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(ws: ServerWebSocket<ControlSocketData>) {
  const messages = bufferedMessages.splice(0, bufferedMessages.length);
  for (const message of messages) {
    if (!trySendBridgeMessage(ws, message)) {
      // Re-buffer this and all remaining messages on failure
      const failedIndex = messages.indexOf(message);
      const remaining = messages.slice(failedIndex);
      bufferedMessages.unshift(...remaining);
      log(`Flush interrupted: re-buffered ${remaining.length} message(s) after send failure`);
      return;
    }
  }
}

function sendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage) {
  trySendBridgeMessage(ws, message);
}

function sendStatus(ws: ServerWebSocket<ControlSocketData>) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}

function broadcastStatus() {
  if (!attachedClaude) return;
  sendStatus(attachedClaude);
}

function sendProtocolMessage(ws: ServerWebSocket<ControlSocketData>, message: ControlServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err: any) {
    log(`Failed to send control message: ${err.message}`);
  }
}

function currentStatus(): DaemonStatus {
  const snapshot = tuiConnectionState.snapshot();
  return {
    bridgeReady: tuiConnectionState.canReply(),
    tuiConnected: snapshot.tuiConnected,
    controllerConnected: !!attachedClaude,
    threadId: codex.activeThreadId,
    queuedMessageCount: bufferedMessages.length + statusBuffer.size,
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    controllerProxyUrl: controller?.proxyUrl,
    pid: process.pid,
  };
}

function currentWaitingMessage() {
  return `⏳ Waiting for ${peerName} to connect. Run in another terminal:\n${attachCmd}`;
}

function currentReadyMessage() {
  return `✅ ${peerName} connected (${codex.activeThreadId}). Bridge ready.`;
}

function notifyCodexClaudeOnline(): boolean {
  const message = !codexCollaborationKickoffSent
    ? [
        `🤝 ${controllerName} has connected via AgentBridge.`,
        "You are now in a multi-agent collaboration session.",
        `When you receive a complex task, propose a division of labor to ${controllerName}.`,
        `${controllerName} can send you messages — they will appear as injected user messages.`,
        `Respond naturally and ${controllerName} will receive your output via AgentBridge.`,
      ].join("\n")
    : `✅ AgentBridge connected to ${controllerName}.`;

  const delivered = codex.injectMessage(message);
  if (!delivered) {
    log(`Deferred Claude-online notice to ${peerName} — will retry after current turn completes`);
    return false;
  }

  claudeOnlineNoticeSent = true;
  claudeOfflineNoticeShown = false;
  codexCollaborationKickoffSent = true;
  return true;
}

function shouldNotifyCodexClaudeOnline() {
  return !claudeOnlineNoticeSent || claudeOfflineNoticeShown;
}

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    source: "codex",
    content,
    timestamp: Date.now(),
  };
}

function writePidFile() {
  daemonLifecycle.writePid();
}

function removePidFile() {
  daemonLifecycle.removePidFile();
}

function writeStatusFile() {
  daemonLifecycle.writeStatus({
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    controllerProxyUrl: controller?.proxyUrl,
    controlPort: CONTROL_PORT,
    pid: process.pid,
  });
}

function removeStatusFile() {
  daemonLifecycle.removeStatusFile();
}

async function bootCodex() {
  log("Starting AgentBridge daemon...");
  log(`${peerName} app-server: ${codex.appServerUrl}`);
  log(`${peerName} proxy: ${codex.proxyUrl}`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);

  try {
    await codex.start();
    codexBootstrapped = true;

    if (controller) {
      try {
        await controller.start();
        log(`Controller Codex middleman proxy: ${controller.proxyUrl}`);
      } catch (err: any) {
        log(`Failed to start controller Codex middleman: ${err.message}`);
        emitToClaude(
          systemMessage(
            "system_controller_start_failed",
            `❌ AgentBridge failed to start the controller Codex middleman: ${err.message}`,
          ),
        );
      }
    }

    writeStatusFile();

    emitToClaude(systemMessage("system_waiting", currentWaitingMessage()));
    broadcastStatus();
  } catch (err: any) {
    log(`Failed to start ${peerName}: ${err.message}`);
    emitToClaude(
      systemMessage(
        "system_codex_start_failed",
        `❌ AgentBridge failed to start ${peerName} app-server: ${err.message}`,
      ),
    );
    broadcastStatus();
  }
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  clearPendingClaudeDisconnect(`daemon shutdown (${reason})`);
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  controller?.stop();
  removePidFile();
  removeStatusFile();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { removePidFile(); removeStatusFile(); });
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [AgentBridgeDaemon] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(stateDir.logFile, line);
  } catch {}
}

// Refuse to start if user intentionally killed the daemon.
// This prevents stale auto-reconnect loops from relaunching us.
// Only `agentbridge codex` / `ensureRunning` clears the sentinel before launching.
if (daemonLifecycle.wasKilled()) {
  log("Killed sentinel found — daemon was intentionally stopped. Exiting immediately.");
  process.exit(0);
}

writePidFile();
startControlServer();
void bootCodex();
