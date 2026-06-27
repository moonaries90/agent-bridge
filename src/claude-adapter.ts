/**
 * Claude Code MCP Server — Dual-Mode Message Transport
 *
 * Supports two delivery modes:
 *   - Push mode (OAuth): real-time via notifications/claude/channel
 *   - Pull mode (API key): message queue + get_messages tool
 *
 * Mode defaults to push in auto mode, or set explicitly via AGENTBRIDGE_MODE env var.
 *
 * Emits:
 *   - "ready"   ()                   — MCP connected, mode resolved
 *   - "reply"   (msg: BridgeMessage) — Claude used the reply tool
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { StateDirResolver } from "./state-dir";
import type { BridgeMessage } from "./types";

export type ReplySender = (msg: BridgeMessage, requireReply?: boolean) => Promise<{ success: boolean; error?: string }>;
export type DeliveryMode = "push" | "pull" | "auto";

/** Build the system instructions for Claude, parameterized by peer name. */
export function buildClaudeInstructions(peerName: string): string {
  const peerLower = peerName.toLowerCase();
  return [
    `${peerName} is an AI coding agent running in a separate session on the same machine.`,
    "",
    "## Message delivery",
    `Messages from ${peerName} may arrive in two ways depending on the connection mode:`,
    `- As <channel source="agentbridge" chat_id="..." user="${peerName}" ...> tags (push mode)`,
    "- Via the get_messages tool (pull mode)",
    "",
    "## Collaboration roles",
    "Default roles in this setup:",
    "- Claude: Reviewer, Planner, Hypothesis Challenger",
    `- ${peerName}: Implementer, Executor, Reproducer/Verifier`,
    `- Expect ${peerName} to provide independent technical judgment and evidence, not passive agreement.`,
    "",
    "## Thinking patterns (task-driven)",
    "- Analytical/review tasks: Independent Analysis & Convergence",
    "- Implementation tasks: Architect -> Builder -> Critic",
    "- Debugging tasks: Hypothesis -> Experiment -> Interpretation",
    "",
    "## Collaboration language",
    "- Use explicit phrases such as \"My independent view is:\", \"I agree on:\", \"I disagree on:\", and \"Current consensus:\".",
    "",
    "## How to interact",
    `- Use the reply tool to send messages back to ${peerName} — pass chat_id back.`,
    `- Use the get_messages tool to check for pending messages from ${peerName}.`,
    "- After sending a reply, call get_messages to check for responses.",
    `- When the user asks about ${peerName} status or progress, call get_messages.`,
    "",
    "## Turn coordination",
    `- When you see '⏳ ${peerName} is working', do NOT call the reply tool — wait for '✅ ${peerName} finished'.`,
    `- After ${peerName} finishes a turn, you have an attention window to review and respond before new messages arrive.`,
    `- If the reply tool returns a busy error, ${peerName} is still executing — wait and try again later.`,
    "",
    "## Context management",
    `- Over long sessions, ${peerName}'s context window will fill up. At phase boundaries or when context gets large, include the marker \`[SESSION_RESET]\` in your reply text to reset ${peerName}'s session.`,
    `- Example: \`[SESSION_RESET] Phase 1 complete. Starting Phase 2: implement the auth module.\``,
    `- After reset, ${peerName} starts fresh with NO memory of previous context. Always include a summary of what was done so far in the reset message.`,
    `- Use [SESSION_RESET] proactively — do not wait for ${peerName} to run out of context.`,
  ].join("\n");
}

/**
 * Backward-compatible default. Reads AGENTBRIDGE_PEER so the instructions
 * reference the correct peer name (Codex/Kimi/ZCode) rather than hardcoding
 * "Codex". Falls back to "Codex" for unset env (legacy behavior).
 */
export function resolvePeerName(env = process.env): string {
  const peer = (env.AGENTBRIDGE_PEER ?? "codex").toLowerCase();
  if (peer === "kimi") return "Kimi";
  if (peer === "zcode") return "ZCode";
  return "Codex";
}
export const CLAUDE_INSTRUCTIONS = buildClaudeInstructions(resolvePeerName());

export class ClaudeAdapter extends EventEmitter {
  private server: Server;
  private notificationSeq = 0;
  private sessionId: string;
  private readonly notificationIdPrefix: string;
  private readonly instanceId: string;
  private replySender: ReplySender | null = null;
  private readonly logFile: string;
  private readonly peerName: string;
  private readonly peerId: string;

  // Dual-mode transport
  private readonly configuredMode: DeliveryMode;
  private resolvedMode: "push" | "pull" | null = null;
  private pendingMessages: BridgeMessage[] = [];
  private readonly maxBufferedMessages: number;
  private droppedMessageCount = 0;

  constructor(logFile = new StateDirResolver().logFile) {
    super();
    this.logFile = logFile;
    this.instanceId = randomUUID().slice(0, 8);
    // Determine peer name from env (same var daemon uses)
    const peer = (process.env.AGENTBRIDGE_PEER ?? "codex").toLowerCase();
    this.peerName = resolvePeerName();
    this.peerId = peer === "kimi" ? "kimi" : peer === "zcode" ? "zcode" : "codex";
    this.sessionId = `${this.peerId}_${Date.now()}`;
    this.notificationIdPrefix = randomUUID().replace(/-/g, "").slice(0, 12);
    this.log(`ClaudeAdapter created (instance=${this.instanceId}, peer=${this.peerName})`);

    const envMode = process.env.AGENTBRIDGE_MODE as DeliveryMode | undefined;
    this.configuredMode = envMode && ["push", "pull", "auto"].includes(envMode) ? envMode : "auto";
    this.maxBufferedMessages = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);

    this.server = new Server(
      { name: "agentbridge", version: "0.1.0" },
      {
        capabilities: {
          experimental: { "claude/channel": {} },
          tools: {},
        },
        instructions: buildClaudeInstructions(this.peerName),
      },
    );

    this.setupHandlers();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start() {
    const transport = new StdioServerTransport();
    this.resolveMode();
    await this.server.connect(transport);
    this.log(`MCP server connected (mode: ${this.resolvedMode})`);
    this.emit("ready");
  }

  /** Register the async sender that bridge provides for reply delivery. */
  setReplySender(sender: ReplySender) {
    this.replySender = sender;
  }

  /** Returns the resolved delivery mode. */
  getDeliveryMode(): "push" | "pull" {
    return this.resolvedMode ?? "pull";
  }

  /** Returns the number of messages waiting in the pull queue. */
  getPendingMessageCount(): number {
    return this.pendingMessages.length;
  }

  // ── Mode Detection ─────────────────────────────────────────

  private resolveMode(): void {
    if (this.resolvedMode) return;

    if (this.configuredMode === "push" || this.configuredMode === "pull") {
      this.resolvedMode = this.configuredMode;
      this.log(`Delivery mode set by AGENTBRIDGE_MODE: ${this.resolvedMode}`);
    } else {
      // Default to push — AgentBridge always runs as a Claude Code plugin
      // with --dangerously-load-development-channels, so channel delivery
      // is available. If push fails, pushViaChannel already falls back to
      // queueForPull per-message.
      this.resolvedMode = "push";
      this.log("Delivery mode defaulting to push (set AGENTBRIDGE_MODE=pull to use polling instead)");
    }
  }

  // ── Message Delivery ───────────────────────────────────────

  async pushNotification(message: BridgeMessage) {
    this.log(`pushNotification (instance=${this.instanceId}, mode=${this.resolvedMode}, msgId=${message.id}, len=${message.content.length})`);
    if (this.resolvedMode === "push") {
      await this.pushViaChannel(message);
    } else {
      this.queueForPull(message);
    }
  }

  private async pushViaChannel(message: BridgeMessage) {
    const msgId = `${this.peerId}_msg_${this.notificationIdPrefix}_${++this.notificationSeq}`;
    const ts = new Date(message.timestamp).toISOString();

    try {
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: message.content,
          meta: {
            chat_id: this.sessionId,
            message_id: msgId,
            user: this.peerName,
            user_id: this.peerId,
            ts,
            source_type: this.peerId,
          },
        },
      });
      this.log(`Pushed notification: ${msgId}`);
    } catch (e: any) {
      this.log(`Push notification failed: ${e.message}`);
      this.queueForPull(message);
    }
  }

  private queueForPull(message: BridgeMessage) {
    if (this.pendingMessages.length >= this.maxBufferedMessages) {
      this.pendingMessages.shift();
      this.droppedMessageCount++;
      this.log(`Message queue full, dropped oldest message (total dropped: ${this.droppedMessageCount})`);
    }
    this.pendingMessages.push(message);
    this.log(`Queued message for pull (${this.pendingMessages.length} pending, instance=${this.instanceId})`);
  }

  // ── get_messages ───────────────────────────────────────────

  private drainMessages(): { content: Array<{ type: "text"; text: string }> } {
    this.log(`get_messages called (instance=${this.instanceId}, pending=${this.pendingMessages.length}, dropped=${this.droppedMessageCount})`);
    if (this.pendingMessages.length === 0 && this.droppedMessageCount === 0) {
      return {
        content: [{ type: "text" as const, text: `No new messages from ${this.peerName}.` }],
      };
    }

    // Snapshot and clear atomically to avoid issues with concurrent writes
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    const dropped = this.droppedMessageCount;
    this.droppedMessageCount = 0;

    const count = messages.length;
    let header = `[${count} new message${count > 1 ? "s" : ""} from ${this.peerName}]`;
    if (dropped > 0) {
      header += ` (${dropped} older message${dropped > 1 ? "s" : ""} were dropped due to queue overflow)`;
    }
    header += `\nchat_id: ${this.sessionId}`;

    const formatted = messages
      .map((msg, i) => {
        const ts = new Date(msg.timestamp).toISOString();
        return `---\n[${i + 1}] ${ts}\n${this.peerName}: ${msg.content}`;
      })
      .join("\n\n");

    this.log(`get_messages returning ${count} message(s) (instance=${this.instanceId}, dropped=${dropped})`);
    return {
      content: [
        {
          type: "text" as const,
          text: `${header}\n\n${formatted}`,
        },
      ],
    };
  }

  // ── MCP Tool Handlers ─────────────────────────────────────

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "reply",
          description:
            `Send a message back to ${this.peerName}. Your reply will be injected into the ${this.peerName} session as a new user turn.`,
          inputSchema: {
            type: "object" as const,
            properties: {
              chat_id: {
                type: "string",
                description: "The conversation to reply in (from the inbound <channel> tag).",
              },
              text: {
                type: "string",
                description: `The message to send to ${this.peerName}.`,
              },
              require_reply: {
                type: "boolean",
                description: `When true, ${this.peerName} is required to send a reply. All ${this.peerName} messages from this turn will be forwarded immediately (bypassing STATUS buffering). Use this when you need a direct answer from ${this.peerName}.`,
              },
            },
            required: ["text"],
          },
        },
        {
          name: "get_messages",
          description:
            `Check for new messages from ${this.peerName}. Call this after sending a reply or when you expect a response from ${this.peerName}.`,
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "reply") {
        return this.handleReply(args as Record<string, unknown>);
      }

      if (name === "get_messages") {
        return this.drainMessages();
      }

      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    });
  }

  private async handleReply(args: Record<string, unknown>) {
    const text = args?.text as string | undefined;
    if (!text) {
      return {
        content: [{ type: "text" as const, text: "Error: missing required parameter 'text'" }],
        isError: true,
      };
    }

    const requireReply = args?.require_reply === true;

    const bridgeMsg: BridgeMessage = {
      id: (args?.chat_id as string) ?? `reply_${Date.now()}`,
      source: "claude",
      content: text,
      timestamp: Date.now(),
    };

    if (!this.replySender) {
      this.log("No reply sender registered");
      return {
        content: [{ type: "text" as const, text: "Error: bridge not initialized, cannot send reply." }],
        isError: true,
      };
    }

    const result = await this.replySender(bridgeMsg, requireReply);
    if (!result.success) {
      this.log(`Reply delivery failed: ${result.error}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    // Include pending message hint
    const pending = this.pendingMessages.length;
    let responseText = `Reply sent to ${this.peerName}.`;
    if (pending > 0) {
      responseText += ` Note: ${pending} unread ${this.peerName} message${pending > 1 ? "s" : ""} already waiting \u2014 call get_messages to read them.`;
    }

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  }

  private log(msg: string) {
    const line = `[${new Date().toISOString()}] [ClaudeAdapter] ${msg}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(this.logFile, line);
    } catch {}
  }
}
