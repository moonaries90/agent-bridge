import type { BridgeMessage } from "./types";

export type MarkerLevel = "important" | "status" | "fyi" | "untagged";
export type FilterMode = "filtered" | "full";
export type PullMessageMode = "markers" | "full";

export interface FilterResult {
  action: "forward" | "buffer" | "drop";
  marker: MarkerLevel;
}

const MARKER_REGEX = /^\s*\[(IMPORTANT|STATUS|FYI)(?:\s+[^\]]*)?\]\s*/i;
const DEFAULT_PULL_MAX_MESSAGE_CHARS = 6_000;
const DEFAULT_PULL_MAX_TOTAL_CHARS = 24_000;

export function parseMarker(content: string): { marker: MarkerLevel; body: string } {
  const match = content.match(MARKER_REGEX);
  if (!match) return { marker: "untagged", body: content };
  return {
    marker: match[1].toLowerCase() as MarkerLevel,
    body: content.slice(match[0].length),
  };
}

export function classifyMessage(content: string, mode: FilterMode): FilterResult {
  if (mode === "full") return { action: "forward", marker: "untagged" };
  const { marker } = parseMarker(content);
  switch (marker) {
    case "important":
      return { action: "forward", marker };
    case "status":
      return { action: "buffer", marker };
    case "fyi":
      return { action: "drop", marker };
    case "untagged":
      return { action: "forward", marker };
  }
}

export interface PullMessageFormatOptions {
  peerName: string;
  sessionId: string;
  messages: BridgeMessage[];
  droppedMessageCount?: number;
  mode?: PullMessageMode;
  maxMessageChars?: number;
  maxTotalChars?: number;
}

export function resolvePullMessageMode(env = process.env): PullMessageMode {
  return env.AGENTBRIDGE_GET_MESSAGES_MODE === "full" ? "full" : "markers";
}

export function resolvePullMaxMessageChars(env = process.env): number {
  return parsePositiveInt(env.AGENTBRIDGE_GET_MESSAGES_MAX_MESSAGE_CHARS, DEFAULT_PULL_MAX_MESSAGE_CHARS);
}

export function resolvePullMaxTotalChars(env = process.env): number {
  return parsePositiveInt(env.AGENTBRIDGE_GET_MESSAGES_MAX_TOTAL_CHARS, DEFAULT_PULL_MAX_TOTAL_CHARS);
}

export function formatPullMessages(options: PullMessageFormatOptions): string {
  const mode = options.mode ?? resolvePullMessageMode();
  const maxMessageChars = options.maxMessageChars ?? resolvePullMaxMessageChars();
  const maxTotalChars = options.maxTotalChars ?? resolvePullMaxTotalChars();
  const dropped = options.droppedMessageCount ?? 0;

  const accepted: BridgeMessage[] = [];
  let suppressedByMarker = 0;
  for (const message of options.messages) {
    const { marker } = parseMarker(message.content);
    const shouldInclude = mode === "full" || marker === "important" || marker === "status";
    if (shouldInclude) accepted.push(message);
    else suppressedByMarker++;
  }

  const count = options.messages.length;
  let header = `[${count} new message${count > 1 ? "s" : ""} from ${options.peerName}]`;
  if (dropped > 0) {
    header += ` (${dropped} older message${dropped > 1 ? "s" : ""} were dropped due to queue overflow)`;
  }
  header += `\nchat_id: ${options.sessionId}`;
  if (mode === "markers") {
    header += `\nget_messages filter: returning only [IMPORTANT]/[STATUS] messages`;
  }
  if (suppressedByMarker > 0) {
    header += `\nsuppressed: ${suppressedByMarker} unmarked/[FYI] message${suppressedByMarker > 1 ? "s" : ""}`;
  }

  const parts: string[] = [];
  let omittedBySize = 0;
  let usedChars = header.length + 2;

  for (let i = 0; i < accepted.length; i++) {
    const msg = accepted[i];
    const ts = new Date(msg.timestamp).toISOString();
    const prefix = `---\n[${i + 1}] ${ts}\n${options.peerName}: `;
    const fixedCost = prefix.length + 2;
    const remaining = maxTotalChars - usedChars - fixedCost;
    if (remaining < 200) {
      omittedBySize = accepted.length - i;
      break;
    }
    const contentBudget = Math.max(200, Math.min(maxMessageChars, remaining));
    const content = truncateMiddle(msg.content, contentBudget);
    const part = `${prefix}${content}`;
    parts.push(part);
    usedChars += part.length + 2;
  }

  if (omittedBySize > 0) {
    parts.push(`[suppressed: ${omittedBySize} additional message${omittedBySize > 1 ? "s" : ""} due to get_messages size limit]`);
  }
  if (parts.length === 0 && suppressedByMarker > 0) {
    parts.push("[no marker-qualified messages to return]");
  }

  return `${header}\n\n${parts.join("\n\n")}`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncateMiddle(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const notice = `\n[... truncated ${content.length - maxChars} chars by get_messages safety limit ...]\n`;
  if (maxChars <= notice.length + 20) return content.slice(0, maxChars);
  const available = maxChars - notice.length;
  const headChars = Math.ceil(available * 0.7);
  const tailChars = available - headChars;
  return `${content.slice(0, headChars)}${notice}${content.slice(content.length - tailChars)}`;
}

/**
 * Reminder appended to every controller→peer message. Parameterized by the
 * controller's display name (so the peer addresses the right agent — Codex vs.
 * Claude) and the peer's own name (role-guidance header). Defaults reproduce the
 * original Claude-controller / Codex-peer wording for backward compatibility.
 */
export function buildBridgeContractReminder(
  controllerName = "Claude",
  peerName = "Codex",
): string {
  return `[Bridge Contract] Every message you send is relayed to ${controllerName}. Put exactly ONE marker at the very start of the message:
- [IMPORTANT] — your actual answer/result, decisions, reviews, completions, blockers; anything ${controllerName} must see or act on. This is your main channel.
- [STATUS] — ONLY notable milestones, used sparingly. Good examples: the spec doesn't match the actual behavior; you found a better approach; a meaningful checkpoint (e.g. a phase finished). If nothing noteworthy happened, send NO [STATUS] at all.
- [FYI] — minor background/context ${controllerName} can safely ignore.
The marker MUST be the first text in the message (e.g. "[IMPORTANT] Task done", not "Task done [IMPORTANT]").
Do NOT tag routine steps or your step-by-step thinking as [STATUS] — that floods ${controllerName}. Most intermediate work needs no message at all; just keep working and send ONE [IMPORTANT] result when done.
Keep agentMessage for high-value communication only.

[Git Operations — FORBIDDEN]
You MUST NOT execute any git write commands. This includes but is not limited to:
git commit, git push, git pull, git fetch, git checkout -b, git branch, git merge, git rebase, git cherry-pick, git tag, git stash.
These commands write to the .git directory, which is blocked by your sandbox. Attempting them will cause your session to hang indefinitely.
Read-only git commands (git status, git log, git diff, git show, git rev-parse) are allowed.
All git write operations must be delegated to ${controllerName} via agentMessage. Report what you changed and let ${controllerName} handle branching, committing, and pushing.

[Role Guidance for ${peerName}]
- Your default role: Implementer, Executor, Verifier
- Analytical/review tasks: Independent Analysis & Convergence
- Implementation tasks: Architect -> Builder -> Critic
- Debugging tasks: Hypothesis -> Experiment -> Interpretation
- Do not blindly follow ${controllerName} - challenge with evidence when you disagree
- Use explicit collaboration phrases: "My independent view is:", "I agree on:", "I disagree on:", "Current consensus:"`;
}

export function buildReplyRequiredInstruction(controllerName = "Claude"): string {
  return `\n\n[⚠️ REPLY REQUIRED] ${controllerName} has explicitly requested a reply. You MUST send an agentMessage with [IMPORTANT] marker containing your response. This is a mandatory requirement — do not skip or use [STATUS]/[FYI] markers for this reply.`;
}

export class StatusBuffer {
  private buffer: BridgeMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushThreshold: number;
  private readonly flushTimeoutMs: number;
  private paused = false;

  constructor(
    private readonly onFlush: (summary: BridgeMessage) => void,
    options?: { flushThreshold?: number; flushTimeoutMs?: number },
  ) {
    this.flushThreshold = options?.flushThreshold ?? 3;
    this.flushTimeoutMs = options?.flushTimeoutMs ?? 15000;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Pause automatic flushing (threshold + timeout). Manual flush() still works. */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  /** Resume automatic flushing. Restarts timer if buffer has content. */
  resume(): void {
    this.paused = false;
    if (this.buffer.length > 0) {
      this.resetTimer();
      if (this.buffer.length >= this.flushThreshold) {
        this.flush("threshold reached after resume");
      }
    }
  }

  add(message: BridgeMessage): void {
    this.buffer.push(message);
    if (this.paused) return; // Don't auto-flush while paused
    this.resetTimer();
    if (this.buffer.length >= this.flushThreshold) {
      this.flush("threshold reached");
    }
  }

  flush(reason: string): void {
    if (this.buffer.length === 0) return;
    this.clearTimer();
    const combined = this.buffer
      .map((m) => parseMarker(m.content).body)
      .join("\n---\n");
    const summary: BridgeMessage = {
      id: `status_summary_${Date.now()}`,
      source: "codex",
      content: `[STATUS summary — ${this.buffer.length} update(s), flushed: ${reason}]\n${combined}`,
      timestamp: Date.now(),
    };
    // Clear AFTER calling onFlush — if the send fails, emitToClaude's
    // bufferedMessages fallback will still capture the summary. Clearing
    // first would lose messages when ws.send() throws on a closing socket.
    this.onFlush(summary);
    this.buffer = [];
  }

  dispose(): void {
    this.clearTimer();
    this.buffer = [];
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private resetTimer(): void {
    this.clearTimer();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush("timeout");
    }, this.flushTimeoutMs);
  }
}
