/**
 * Pure helpers for the controller-side middleman (codex-zcode / codex-kimi).
 *
 * When the CONTROLLER is Codex, the daemon injects the peer's replies as real
 * `turn/start` turns into the controller's thread (real-time, no get_messages
 * polling). These helpers shape what gets injected — kept pure so they are unit
 * testable without spawning a daemon/app-server.
 */

import { parseMarker } from "./message-filter";

/**
 * Collapse the peer messages emitted during a SINGLE peer turn into a minimal,
 * non-redundant list.
 *
 * Why: a peer (e.g. ZCode) often emits the same status both as a tagged STATUS
 * message and as an untagged copy in one turn. Injecting each separately would
 * make the controller Codex run one wasted turn per copy. We coalesce them into
 * one injection and drop substrings/duplicates so the controller reacts once.
 *
 * Rules (order-preserving):
 *  - trim each entry; drop empties.
 *  - if an existing kept entry already contains this entry → drop this entry.
 *  - if this entry contains an existing kept entry → replace the shorter one.
 *  - otherwise keep it.
 */
export function dedupePeerTurnContent(parts: string[]): string[] {
  const out: string[] = [];
  for (const raw of parts) {
    const c = raw.trim();
    if (!c) continue;
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i].includes(c)) {
        merged = true;
        break;
      }
      if (c.includes(out[i])) {
        out[i] = c;
        merged = true;
        break;
      }
    }
    if (!merged) out.push(c);
  }
  return out;
}

/**
 * Pick the content worth injecting from a single peer turn.
 *
 * In Codex-controller mode, `require_reply` forwards live [STATUS] updates
 * while the peer is working. Those updates are useful only until a final answer
 * arrives; injecting both makes Codex re-read process narration as fresh input.
 */
export function selectPeerTurnContent(parts: string[]): string[] {
  const annotated = parts
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((content) => ({ content, marker: parseMarker(content).marker }));

  const important = annotated.filter((part) => part.marker === "important");
  if (important.length > 0) return important.map((part) => part.content);

  const finalish = annotated.filter((part) => part.marker !== "status" && part.marker !== "fyi");
  if (finalish.length > 0) return finalish.map((part) => part.content);

  return annotated
    .filter((part) => part.marker !== "fyi")
    .map((part) => part.content);
}

/**
 * Build the single injection string for one peer turn, or null if there is
 * nothing meaningful to inject. The peer name prefix tells the controller Codex
 * the message is from its implementer (not the human user).
 */
export function formatControllerInjection(peerName: string, parts: string[]): string | null {
  const deduped = dedupePeerTurnContent(selectPeerTurnContent(parts));
  if (deduped.length === 0) return null;
  return `[Message from ${peerName}]\n${deduped.join("\n\n")}`;
}

/**
 * The collaboration-role kickoff injected as the controller's first turn. Makes
 * the controller Codex's role explicit and visible in its TUI. (Codex 0.139 also
 * reads the MCP `instructions` field, but that is invisible system context.)
 */
export function buildControllerKickoff(peer: string): string {
  return [
    `🤝 You are the CONTROLLER in an AgentBridge multi-agent session. ${peer} is your IMPLEMENTER, running headless on this machine.`,
    "",
    `## Receiving ${peer} (real-time — no polling)`,
    `- ${peer}'s replies are injected directly into THIS conversation as new messages prefixed "[Message from ${peer}]".`,
    `- You do NOT need to call get_messages — replies arrive automatically as they happen.`,
    `- After assigning work, be patient. ${peer} may take a long time to implement, run commands, or inspect files.`,
    `- Do not use pull mode while less than 30 minutes have passed or ${peer} is still busy.`,
    `- Use get_messages only as replay/fallback when more than 30 minutes have passed, no injected reply arrived, and ${peer} is no longer busy.`,
    "",
    "## Sending",
    `- Use the \`reply\` tool to send a message to ${peer}; it is injected into ${peer}'s session as a new user turn.`,
    `- If \`reply\` returns busy, ${peer} is mid-turn — stop and wait; do not repeatedly poll.`,
    "",
    "## Your role",
    `- Plan and decompose the task; delegate concrete implementation/testing to ${peer}; review its output before moving on.`,
    `- Include [SESSION_RESET] in a reply at phase boundaries to reset ${peer}'s context (always include a progress summary).`,
  ].join("\n");
}
