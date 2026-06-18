export type BridgeDisabledReason = "killed" | "rejected";

/**
 * Resolve the restart command that the disabled-state error message should
 * tell the user to run.
 *
 * Why this exists: `abg kill` writes a `killed` sentinel to EVERY state dir at
 * once. A leftover sentinel surfaces as a disabled-bridge error in whatever
 * session reads it. The original error always said
 * "Restart Claude Code (agentbridge claude)", which is wrong for kimi /
 * codex-kimi / zcode / codex-zcode sessions — it sent users to restart a
 * Claude process that isn't even involved.
 *
 * Resolution order:
 *   1. AGENTBRIDGE_RESTART_CMD — explicit override, set by the CLI launcher
 *      (e.g. codex-zcode.ts sets it to "abg codex-zcode"). Most reliable.
 *   2. Infer from AGENTBRIDGE_PEER. Codex-side bridge (codex-bridge-mcp.ts)
 *      is only ever spawned by `abg codex-kimi` / `abg codex-zcode`, while
 *      the Claude-side bridge.ts is spawned by `abg claude/kimi/zcode`. We
 *      can't tell controller vs peer from peer alone, so peer-only inference
 *      stays conservative (returns the Claude-side command); callers that
 *      know better should pass AGENTBRIDGE_RESTART_CMD.
 *   3. Default: `abg claude`.
 */
function restartCommand(env = process.env): string {
  if (env.AGENTBRIDGE_RESTART_CMD) return env.AGENTBRIDGE_RESTART_CMD;
  const peer = (env.AGENTBRIDGE_PEER ?? "codex").toLowerCase();
  switch (peer) {
    case "kimi":
      return "abg kimi";
    case "zcode":
      return "abg zcode";
    case "codex":
    default:
      return "abg claude";
  }
}

export function disabledReplyError(reason: BridgeDisabledReason, env = process.env): string {
  const cmd = restartCommand(env);
  switch (reason) {
    case "rejected":
      return `AgentBridge rejected this session — another controller session is already connected. Close the other session first, or run \`abg kill\` to reset.`;
    case "killed":
      return `AgentBridge is disabled by \`agentbridge kill\`. Relaunch \`${cmd}\`, switch to a new conversation, or run \`abg kill\` to clear state and then restart \`${cmd}\`.`;
  }
}
