#!/usr/bin/env bun
/**
 * Codex Bridge MCP Server — Codex-CLI-as-controller transport for AgentBridge.
 *
 * This is the Codex-side counterpart of bridge.ts + claude-adapter.ts.
 * It runs as a stdio MCP server that the Codex CLI loads (via `-c mcp_servers.*`
 * override), exposing the same `reply` / `get_messages` tools that Claude gets.
 *
 * Why a separate file instead of reusing bridge.ts?
 *   bridge.ts depends on `notifications/claude/channel` (Claude Code's
 *   experimental push channel) to deliver peer messages. Codex has no such
 *   channel. Instead we deliver peer (Kimi/ZCode) messages via standard MCP
 *   `notifications/*` (best-effort push) AND mirror them into a pull queue
 *   surfaced by `get_messages` — so even if Codex's MCP client swallows the
 *   notification, the agent can still drain messages by calling get_messages.
 *
 * Everything downstream of this MCP server (DaemonClient, control-WS protocol,
 * daemon, peer adapter) is reused unchanged. The protocol field names still say
 * `claude_*` / `codex_to_claude` — they are generic frontend↔peer labels, not
 * Claude-specific; reusing them keeps this a zero-daemon-change feature.
 */

import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { DaemonClient } from "./daemon-client";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { disabledReplyError, type BridgeDisabledReason } from "./bridge-disabled-state";
import { formatPullMessages } from "./message-filter";
import type { BridgeMessage } from "./types";

/**
 * Resolve the peer display name from AGENTBRIDGE_PEER, matching the logic in
 * claude-adapter.ts / daemon.ts. Defaults to "Codex" when unset (legacy).
 *
 * This file is shared by `abg codex` (peer=Codex), `abg codex-kimi`
 * (peer=Kimi), and `abg codex-zcode` (peer=ZCode) — all three launch the same
 * codex-bridge-mcp.ts via an inline `-c mcp_servers.agentbridge.*` override,
 * so the peer name must be derived from env, not hardcoded.
 */
function resolvePeerName(env = process.env): string {
  const peer = (env.AGENTBRIDGE_PEER ?? "codex").toLowerCase();
  if (peer === "kimi") return "Kimi";
  if (peer === "zcode") return "ZCode";
  return "Codex";
}

/**
 * Build Codex-specific instructions (self-contained — does NOT reuse
 * buildClaudeInstructions, whose "Claude: Reviewer" role framing is wrong for
 * Codex-as-controller and confuses the agent about which side it is on).
 *
 * Codex is the CONTROLLER here: it decomposes tasks, delegates to the peer,
 * decides when to ask questions vs. proceed, and reviews the peer's output.
 * The peer (Codex/Kimi/ZCode) is the IMPLEMENTER that executes.
 *
 * Delivery: this is attached as the MCP server's `instructions` field (Codex
 * 0.139 reads it into system context). The collaboration role is ALSO delivered
 * as a real injected first turn by the daemon (controller-injection.ts
 * buildControllerKickoff), which is what makes the role visible in the TUI.
 */
function buildCodexInstructions(peer: string): string {
  return [
    `You are running inside Codex CLI, acting as the CONTROLLER in a multi-agent collaboration session via AgentBridge.`,
    `${peer} is an AI coding agent running in a separate session on the same machine. You drive the collaboration; ${peer} executes.`,
    "",
    "## Your role (Codex — controller)",
    "- You are the PLANNER and DECISION-MAKER: decompose the task, assign subtasks to yourself or to " + peer + ", and decide the order of work.",
    "- You are the REVIEWER: when " + peer + " finishes a subtask, review its output before moving on.",
    `- ${peer} is the IMPLEMENTER/EXECUTOR: delegate concrete coding, testing, and verification work to it.`,
    `- Do NOT do everything yourself — proactively propose a division of labor to ${peer} via the reply tool.`,
    "",
    `## Receiving ${peer} replies (real-time — no polling)`,
    `${peer}'s replies are injected directly into THIS conversation as new messages prefixed "[Message from ${peer}]", in real time as they happen.`,
    `- You do NOT need to call get_messages — replies arrive automatically.`,
    `- get_messages is replay/fallback only: use it only when more than 30 minutes have passed since your reply, no injected "[Message from ${peer}]" arrived, and ${peer} is no longer busy.`,
    `- If less than 30 minutes have passed, or ${peer} is still busy, be patient and do not use pull mode.`,
    "",
    "## How to interact",
    `- Use the \`reply\` tool to send a message to ${peer} — pass chat_id back.`,
    `- After you call \`reply\`, END YOUR TURN and wait. ${peer}'s response is injected automatically as a new "[Message from ${peer}]" message, which starts your next turn.`,
    `- Do NOT call get_messages in a loop. While you keep calling tools your turn stays active, and ${peer}'s reply CANNOT be injected until you go idle — polling actively BLOCKS the very reply you are waiting for.`,
    "",
    "## Turn coordination",
    `- If \`reply\` returns a busy error, ${peer} is still executing — stop and wait; the result will arrive as an injected message (do not poll).`,
    `- ${peer} may take a long time to implement, run tests, or inspect files. Slow response is normal; wait patiently instead of repeatedly checking pull mode.`,
    `- One exchange = one of your turns: read ${peer}'s injected message, decide, send one \`reply\`, then stop.`,
    "",
    "## Context management",
    `- Over long sessions, ${peer}'s context window will fill up. At phase boundaries or when context gets large, include the marker \`[SESSION_RESET]\` in your reply text to reset ${peer}'s session.`,
    `- After reset, ${peer} starts fresh with NO memory of previous context. Always include a summary of what was done so far in the reset message.`,
    `- Use [SESSION_RESET] proactively — do not wait for ${peer} to run out of context.`,
  ].join("\n");
}

const stateDir = new StateDirResolver();
stateDir.ensure();
const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4603", 10);
const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
const CONTROL_WS_URL = daemonLifecycle.controlWsUrl;

const daemonClient = new DaemonClient(CONTROL_WS_URL);

// ── MCP server (tools + instructions) ───────────────────────────

const instanceId = randomUUID().slice(0, 8);
// Session/chat id prefix reflects the controller side (always Codex, since this
// file only runs when Codex is the controller). The peer is identified by
// peerName (Codex/Kimi/ZCode) below — these are NOT the same thing.
const sessionId = `codex_${Date.now()}`;
const peerName = resolvePeerName(); // Codex | Kimi | ZCode, from AGENTBRIDGE_PEER

let shuttingDown = false;
let daemonDisabled = false;
let daemonDisabledReason: BridgeDisabledReason | null = null;

// --- Kickoff tracking ---
// Codex does not consume the MCP `instructions` field, so we deliver the
// agent's role/collaboration description as a pushed system message the first
// time the daemon reports the bridge ready. Tracked so we only send it once
// per process lifetime (not on every reconnect).
let hasSentKickoff = false;

// --- Disabled-state recovery (mirrors bridge.ts) ---
// Unlike Claude's bridge.ts, this file historically had NO recovery poller:
// once a `killed` sentinel disabled the bridge, it stayed disabled forever —
// even after the user cleared the sentinel and restarted the daemon. That left
// Codex sessions permanently stuck ("abg codex-zcode 似乎不可用") because
// `abg kill` writes a sentinel to every state dir, and the Codex MCP child
// (a long-lived subprocess) would re-read it on every reconnect.
const DISABLED_RECOVERY_INTERVAL_MS = 5_000;
let disabledRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let disabledRecoveryInFlight = false;

// Pull-mode queue: every peer message is mirrored here so get_messages can
// surface it even if the push notification didn't reach the agent.
const pendingMessages: BridgeMessage[] = [];
const MAX_BUFFERED_MESSAGES = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
let droppedMessageCount = 0;

const server = new Server(
  { name: "agentbridge-codex", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: buildCodexInstructions(peerName),
  },
);

// Tools: mirror claude-adapter.ts handleReply / drainMessages
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        `Send a message back to ${peerName}. Your reply will be injected into the ${peerName} session as a new user turn.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "The conversation to reply in (from the inbound message).",
          },
          text: {
            type: "string",
            description: `The message to send to ${peerName}.`,
          },
          require_reply: {
            type: "boolean",
            description: `When true, ${peerName} is required to send a reply. All ${peerName} messages from this turn will be forwarded immediately. Use this when you need a direct answer from ${peerName}.`,
          },
        },
        required: ["text"],
      },
    },
    {
      name: "get_messages",
      description:
        `Fallback inbox check for ${peerName} messages. Normally you do NOT need this: ${peerName}'s replies are injected directly into your conversation in real time. Use only if you suspect a message was missed.`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "reply") return handleReply(args as Record<string, unknown>);
  if (name === "get_messages") return drainMessages();
  return {
    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

async function handleReply(args: Record<string, unknown>) {
  const text = args?.text as string | undefined;
  if (!text) {
    return {
      content: [{ type: "text" as const, text: "Error: missing required parameter 'text'" }],
      isError: true,
    };
  }
  const requireReply = args?.require_reply === true;

  if (daemonDisabled) {
    return {
      content: [{ type: "text" as const, text: `Error: ${disabledReplyError(daemonDisabledReason ?? "killed")}` }],
      isError: true,
    };
  }

  const bridgeMsg: BridgeMessage = {
    id: (args?.chat_id as string) ?? `reply_${Date.now()}`,
    source: "claude", // control protocol reuses "claude" as the controller source label
    content: text,
    timestamp: Date.now(),
  };

  const result = await daemonClient.sendReply(bridgeMsg, requireReply);
  if (!result.success) {
    return {
      content: [{ type: "text" as const, text: `Error: ${result.error}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Reply sent to ${peerName}. Its response will arrive automatically as a new "[Message from ${peerName}]" message — END YOUR TURN and wait patiently. Do NOT poll get_messages unless more than 30 minutes have passed, no injected reply arrived, and ${peerName} is no longer busy.`,
      },
    ],
  };
}

function drainMessages(): { content: Array<{ type: "text"; text: string }> } {
  if (pendingMessages.length === 0 && droppedMessageCount === 0) {
    return {
      content: [{ type: "text" as const, text: `No new messages from ${peerName}.` }],
    };
  }
  const messages = pendingMessages.splice(0, pendingMessages.length);
  const dropped = droppedMessageCount;
  droppedMessageCount = 0;

  return {
    content: [{
      type: "text" as const,
      text: formatPullMessages({
        peerName,
        sessionId,
        messages,
        droppedMessageCount: dropped,
      }),
    }],
  };
}

// ── Push: peer message → standard MCP notification + mirror to queue ──

/**
 * Deliver an incoming peer message to the Codex agent.
 *
 * Two-pronged strategy (Codex has no claude/channel equivalent):
 *   1. Emit a standard MCP `notifications/message` so a well-behaved MCP
 *      client can surface it to the agent promptly.
 *   2. ALWAYS mirror into the pull queue — get_messages is the guaranteed
 *      delivery path if the client ignores server-initiated notifications.
 */
async function deliverPeerMessage(message: BridgeMessage) {
  // Mirror to pull queue first (guaranteed delivery), then attempt push.
  if (pendingMessages.length >= MAX_BUFFERED_MESSAGES) {
    pendingMessages.shift();
    droppedMessageCount++;
    log(`Message queue full, dropped oldest message (total dropped: ${droppedMessageCount})`);
  }
  pendingMessages.push(message);

  try {
    await server.notification({
      method: "notifications/message",
      params: {
        level: "info",
        data: {
          chat_id: sessionId,
          message_id: message.id,
          user: peerName,
          ts: new Date(message.timestamp).toISOString(),
          content: message.content,
        },
      },
    });
    log(`Pushed notification for ${message.id} (len=${message.content.length}, also queued)`);
  } catch (e: any) {
    log(`Push notification failed (${e.message}); message remains in pull queue`);
  }
}

// ── Daemon wiring (mirrors bridge.ts) ────────────────────────────

daemonClient.on("codexMessage", (message: BridgeMessage) => {
  log(`Forwarding daemon → Codex (${message.content.length} chars)`);
  void deliverPeerMessage(message);
});

daemonClient.on("status", (status) => {
  log(
    `Daemon status: ready=${status.bridgeReady} tui=${status.tuiConnected} thread=${status.threadId ?? "none"} queued=${status.queuedMessageCount}`,
  );

  // NOTE: the collaboration kickoff is delivered by the daemon as a real
  // injected turn (see controller-injection.ts buildControllerKickoff). We do
  // NOT also push it here — it would only land in the get_messages fallback
  // queue and nudge the agent to poll, which keeps it busy and blocks peer-reply
  // injection. Codex 0.139 also reads the MCP `instructions` field above.
  if (!hasSentKickoff && status.bridgeReady) {
    hasSentKickoff = true;
    log(`Bridge ready — controller kickoff delivered by daemon injection (peer=${peerName})`);
  }
});

daemonClient.on("disconnect", () => {
  if (shuttingDown || daemonDisabled) return;
  log("Daemon control connection closed — will attempt to reconnect");
  void reconnectToDaemon();
});

daemonClient.on("rejected", async () => {
  if (shuttingDown || daemonDisabled) return;
  // The daemon replaced us with another controller session (CLI ↔ App switch).
  // This is NOT a permanent failure — the other side will eventually
  // disconnect, and we should reconnect then. Enter a recoverable disabled
  // state (same poller as the killed-sentinel recovery) instead of dying.
  log("Daemon replaced this session (close code 4001) — another controller is active. Entering standby, will reconnect when the slot frees up.");
  daemonDisabled = true;
  daemonDisabledReason = "rejected";
  await daemonClient.disconnect();
  startDisabledRecoveryPoller();
});

async function connectToDaemon() {
  if (daemonDisabled) {
    log("connectToDaemon() skipped — bridge is disabled");
    return;
  }
  try {
    await daemonLifecycle.ensureRunning();
    await daemonClient.connect();
    daemonClient.attachClaude();
    daemonDisabledReason = null;
    log(`Connected to daemon at ${CONTROL_WS_URL}`);
  } catch (err: any) {
    log(`Failed to connect to daemon: ${err.message}`);
    throw err;
  }
}

const MAX_RECONNECT_DELAY_MS = 30_000;
let reconnectTask: Promise<void> | null = null;

function reconnectToDaemon(): Promise<void> {
  if (shuttingDown || daemonDisabled) return Promise.resolve();
  if (reconnectTask) {
    log("Skipping reconnect — another reconnect is already in progress");
    return reconnectTask;
  }
  reconnectTask = (async () => {
    try {
      for (let attempt = 0; !shuttingDown; attempt += 1) {
        if (daemonLifecycle.wasKilled()) {
          await enterDisabledState(
            "Daemon was intentionally killed by user (killed sentinel found) — not reconnecting",
            "⛔ AgentBridge was stopped by `agentbridge kill`. Restart Codex (`abg codex-kimi`) to reconnect.",
          );
          return;
        }
        const delayMs = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        if (attempt > 0) log(`Reconnect attempt ${attempt + 1}, waiting ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (shuttingDown) return;
        try {
          await connectToDaemon();
          log("Reconnected to AgentBridge daemon successfully");
          return;
        } catch {
          // retry with backoff
        }
      }
    } finally {
      reconnectTask = null;
    }
  })();
  return reconnectTask;
}

async function enterDisabledState(logMessage: string, _notificationContent: string) {
  if (daemonDisabled) return;
  daemonDisabled = true;
  daemonDisabledReason = "killed";
  log(logMessage);
  await daemonClient.disconnect();
  startDisabledRecoveryPoller();
}

/**
 * Poll periodically while disabled. If the killed sentinel is cleared (e.g. the
 * user re-ran `abg codex-zcode`, which calls clearKilled()) and the daemon is
 * healthy again, reconnect automatically instead of staying dead forever.
 */
function startDisabledRecoveryPoller() {
  if (disabledRecoveryTimer || shuttingDown) return;
  log(`Starting disabled-state recovery poller (${DISABLED_RECOVERY_INTERVAL_MS}ms)`);
  disabledRecoveryTimer = setInterval(() => {
    void pollDisabledRecovery();
  }, DISABLED_RECOVERY_INTERVAL_MS);
}

function stopDisabledRecoveryPoller() {
  if (!disabledRecoveryTimer) return;
  clearInterval(disabledRecoveryTimer);
  disabledRecoveryTimer = null;
  disabledRecoveryInFlight = false;
  log("Stopped disabled-state recovery poller");
}

async function pollDisabledRecovery() {
  if (!daemonDisabled || shuttingDown || disabledRecoveryInFlight) return;
  disabledRecoveryInFlight = true;
  try {
    // Still killed? Keep waiting.
    if (daemonLifecycle.wasKilled()) return;

    const healthy = await daemonLifecycle.isHealthy();
    if (!healthy) return;

    // If we were rejected (replaced by another controller), don't reconnect
    // until the other controller has actually disconnected — otherwise the two
    // sides ping-pong, each replacing the other every 5 seconds. We check the
    // daemon's /healthz for controllerConnected.
    if (daemonDisabledReason === "rejected") {
      try {
        const resp = await fetch(daemonLifecycle.healthUrl);
        if (resp.ok) {
          const status = await resp.json();
          if (status.controllerConnected) {
            // Another controller is still active — keep waiting.
            return;
          }
        }
      } catch {
        // healthz failed — fall through to attempt reconnect anyway
      }
    }

    log("Disabled-state recovery conditions met — attempting direct daemon reconnect");
    try {
      await daemonClient.connect();
      daemonClient.attachClaude();
      daemonDisabled = false;
      daemonDisabledReason = null;
      stopDisabledRecoveryPoller();
      log("Recovered after conditions cleared. Daemon reconnected.");
    } catch (err: any) {
      log(`Disabled-state direct reconnect failed: ${err.message}`);
      daemonDisabled = false;
      daemonDisabledReason = null;
      stopDisabledRecoveryPoller();
      void reconnectToDaemon();
    }
  } finally {
    disabledRecoveryInFlight = false;
  }
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down Codex bridge (${reason})...`);
  stopDisabledRecoveryPoller();
  const hardExit = setTimeout(() => {
    log("Shutdown timed out waiting for daemon disconnect; forcing exit");
    process.exit(0);
  }, 3000);
  void daemonClient.disconnect().finally(() => {
    clearTimeout(hardExit);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [CodexBridgeMCP] ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(stateDir.logFile, line); } catch {}
}

log(`Starting Codex bridge MCP (instance=${instanceId}, daemon ws ${CONTROL_WS_URL}, peer=${peerName})`);

(async () => {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("MCP server connected over stdio");

    if (daemonLifecycle.wasKilled()) {
      await enterDisabledState(
        "Killed sentinel found — bridge staying idle",
        "idle",
      );
      return;
    }
    await connectToDaemon();
  } catch (err: any) {
    log(`Fatal: failed to start Codex bridge: ${err.message}`);
  }
})();
