/**
 * Collaboration section content for CLAUDE.md and AGENTS.md.
 *
 * These are injected by `abg init` into project-level instruction files
 * so that agents auto-discover the multi-agent collaboration setup.
 *
 * Content must be generic (not project-specific) and under ~30 lines each.
 * Tool usage details are already covered by MCP server instructions —
 * these sections focus on *when* and *why* to collaborate.
 */

export const MARKER_ID = "AgentBridge";

/** Build the CLAUDE.md collaboration section, parameterized by peer name. */
export function buildClaudeMdSection(peerName: string): string {
  const peerLower = peerName.toLowerCase();
  return `\
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (${peerName}) is available in a parallel session on this machine.

### Communication mechanism
- **Claude → ${peerName}**: Use the AgentBridge MCP tools (\`reply\` / \`get_messages\`) — these are yours only.
- **${peerName} → Claude**: ${peerName} has no symmetric tool. The bridge transparently intercepts ${peerName}'s normal output and forwards it to you. Messages arrive as push notifications (or via \`get_messages\` in pull mode).
- If ${peerName} ever complains it can't find a "send-to-Claude" API, remind it that its side is transparent — it just writes a reply and you'll see it.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities you lack (e.g., sandboxed code execution, independent verification).
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to ${peerName} rather than doing everything yourself.

### Capability comparison
| Capability | Claude (you) | ${peerName} |
|---|---|---|
| Architecture & planning | Strong | Moderate |
| Code review & analysis | Strong | Strong |
| Sandboxed code execution | No | Yes |
| File editing & refactoring | Yes (via tools) | Yes (via sandbox) |
| Web search & docs | Yes | Limited |
| Independent verification | Cross-review | Reproduce & test |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** to ${peerName} via the reply tool.
2. State what you'll handle and what you'd like ${peerName} to take on.
3. Ask for ${peerName}'s agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.`;
}

/**
 * Build the AGENTS.md collaboration section (peer-side).
 *
 * The controlling agent is referred to generically as "the controller" rather
 * than hardcoding "Claude" — the controller may be Claude (abg claude) OR Codex
 * (abg codex-zcode / codex-kimi), so a fixed name would be wrong half the time.
 * The authoritative, per-session role/name is still delivered at runtime (the
 * daemon injects a kickoff turn + the MCP `instructions` field).
 */
export function buildAgentsMdSection(peerName: string): string {
  return `\
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent — **the controller**, which drives this collaboration via AgentBridge — is in a parallel session on this machine.

### Communication mechanism (read this first)
AgentBridge is a **transparent proxy** on your side. You do **not** have a tool to "send a message" to the controller.

- **${peerName} → the controller**: Just write your normal response. The bridge intercepts your output and forwards it to the controller automatically. No tool call needed.
- **The controller → ${peerName}**: The controller uses its own MCP tools (\`reply\` / \`get_messages\`). Those messages arrive in your session as new user turns — you'll see them like any other user input.

**Do not** search the AgentBridge source for a ${peerName}-side "send" / "reply" API — it does not exist, and looking for it wastes turns. If you catch yourself thinking "I need to find how to message the controller", stop and just write your reply as normal text.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities the other agent has.
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to the controller rather than doing everything yourself.

### Capability comparison
| Capability | ${peerName} (you) | The controller |
|---|---|---|
| Sandboxed code execution | Yes | Limited |
| Reproduce & verify bugs | Strong | Limited |
| Architecture & planning | Moderate | Strong |
| Code review & analysis | Strong | Strong |
| Web search & docs | Limited | Often |
| File editing & refactoring | Yes (via sandbox) | Yes (via tools) |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** in your response (the controller will receive it).
2. State what you'll handle and what you'd like the controller to take on.
3. Ask for the controller's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.`;
}

/** Backward-compatible defaults (Codex). */
export const CLAUDE_MD_SECTION = buildClaudeMdSection("Codex");
export const AGENTS_MD_SECTION = buildAgentsMdSection("Codex");
