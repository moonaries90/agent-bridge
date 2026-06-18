/**
 * Idempotent agentbridge MCP section management for ~/.codex/config.toml.
 *
 * Why this exists: `abg codex-zcode` injects the agentbridge MCP server via
 * `-c` runtime overrides, which do NOT persist to config.toml. That means only
 * the CLI process launched by `abg codex-zcode` loads the MCP server — the
 * Codex desktop App's app-server (a separate process) never sees it, so the App
 * can't use agentbridge even when viewing the same conversation.
 *
 * Writing the MCP server into config.toml makes it available to ALL Codex
 * processes (CLI + App), at the cost of a single global peer configuration.
 *
 * The TOML section is wrapped in comment markers so it can be safely updated or
 * removed without touching the rest of the user's config.toml. This mirrors the
 * marker-section.ts pattern but uses TOML comments (#) instead of HTML comments.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const MARKER_START = "# AgentBridge:start";
const MARKER_END = "# AgentBridge:end";

export interface AgentBridgeMcpConfig {
  /** Path to codex-bridge-mcp.ts (run via `bun run`). */
  bridgeScript: string;
  /** Peer type: "zcode" | "kimi" | "codex". */
  peer: string;
  /** Control port the MCP server connects to. */
  controlPort: number;
  /** State directory path. */
  stateDir: string;
  /** Path to daemon.ts. */
  daemonEntry: string;
  /** Restart command shown in error messages. */
  restartCmd: string;
}

/**
 * Resolve the Codex config.toml path.
 * Honors CODEX_HOME if set, otherwise defaults to ~/.codex/config.toml.
 */
export function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

/**
 * Build the TOML block for the agentbridge MCP server.
 * Returns the content BETWEEN the markers (markers are added by upsert).
 */
function buildMcpToml(config: AgentBridgeMcpConfig): string {
  return [
    `[mcp_servers.agentbridge]`,
    `type = "stdio"`,
    `command = "bun"`,
    `args = ["run", "${config.bridgeScript}"]`,
    `startup_timeout_sec = 15`,
    ``,
    `[mcp_servers.agentbridge.env]`,
    `AGENTBRIDGE_PEER = "${config.peer}"`,
    `AGENTBRIDGE_CONTROL_PORT = "${config.controlPort}"`,
    `AGENTBRIDGE_STATE_DIR = "${config.stateDir}"`,
    `AGENTBRIDGE_DAEMON_ENTRY = "${config.daemonEntry}"`,
    `AGENTBRIDGE_RESTART_CMD = "${config.restartCmd}"`,
    `AGENTBRIDGE_MODE = "push"`,
  ].join("\n");
}

/**
 * Insert or replace the marked agentbridge section in config.toml content.
 *
 * Cases (mirrors marker-section.ts logic):
 *   1. Markers present and well-formed → replace between markers.
 *   2. Markers absent → append after the [mcp_servers] table header, or at end.
 *   3. Malformed (one marker without its pair) → throw (don't risk corrupting).
 *
 * @param content  - Existing config.toml content (empty string if file missing)
 * @param config   - MCP server configuration
 * @returns Updated config.toml content
 */
export function upsertAgentBridgeMcp(
  content: string,
  config: AgentBridgeMcpConfig,
): string {
  const block = `${MARKER_START}\n${buildMcpToml(config)}\n${MARKER_END}`;
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  const hasStart = startIdx !== -1;
  const hasEnd = endIdx !== -1;

  // Case 1: well-formed marker pair → replace between them.
  if (hasStart && hasEnd && startIdx < endIdx) {
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + MARKER_END.length);
    return before + block + after;
  }

  // Case 3: malformed markers — refuse to write.
  if (hasStart || hasEnd) {
    throw new Error(
      `Malformed AgentBridge markers in config.toml (start=${startIdx}, end=${endIdx}). ` +
        `Please repair the file manually — remove the stray marker(s).`,
    );
  }

  // Case 2: no markers → insert after the [mcp_servers] table header if present,
  // otherwise append at the end. This keeps the agentbridge entry grouped with
  // other MCP servers for readability.
  const mcpHeaderIdx = content.indexOf("[mcp_servers]");
  if (mcpHeaderIdx !== -1) {
    // Find the end of the [mcp_servers] header line.
    const lineEnd = content.indexOf("\n", mcpHeaderIdx);
    const insertPos = lineEnd === -1 ? content.length : lineEnd + 1;
    const before = content.slice(0, insertPos);
    const after = content.slice(insertPos);
    return `${before}\n${block}\n${after}`;
  }

  // No [mcp_servers] header at all — append at end with the header.
  const trimmed = content.endsWith("\n") ? content : content + "\n";
  return `${trimmed}\n[mcp_servers]\n\n${block}\n`;
}

/**
 * Remove the marked agentbridge section from config.toml content.
 * Returns the content with the section removed. If no markers exist, returns
 * the content unchanged.
 */
export function removeAgentBridgeMcp(content: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    return content; // no section to remove
  }
  // Remove from startIdx to endIdx + marker length, plus any trailing blank
  // line that would be left behind.
  let after = content.slice(endIdx + MARKER_END.length);
  // Strip a leading newline so we don't leave a blank gap.
  if (after.startsWith("\n")) after = after.slice(1);
  return content.slice(0, startIdx) + after;
}

/**
 * Check whether config.toml currently contains the agentbridge MCP section.
 * Used by `abg codex-zcode` / `abg codex-kimi` to decide whether to also pass
 * `-c` runtime overrides — if config.toml already provides the MCP server,
 * passing `-c` would create a DUPLICATE and the daemon would reject the second
 * connection ("another controller session is already connected").
 */
export function hasAgentBridgeMcp(): boolean {
  const configPath = codexConfigPath();
  try {
    const content = readFileSync(configPath, "utf-8");
    return content.includes(MARKER_START);
  } catch {
    return false;
  }
}

/**
 * Read config.toml, upsert the agentbridge section, and write it back.
 * Creates the file (and parent dir) if it doesn't exist.
 *
 * @returns A human-readable status string for logging.
 */
export function persistAgentBridgeMcp(config: AgentBridgeMcpConfig): string {
  const configPath = codexConfigPath();
  let content = "";
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    // File doesn't exist — will be created.
  }

  const hadMarkers = content.includes(MARKER_START);
  const updated = upsertAgentBridgeMcp(content, config);

  // Ensure parent directory exists.
  const parent = dirname(configPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  writeFileSync(configPath, updated, "utf-8");

  const peerLabel = config.peer.charAt(0).toUpperCase() + config.peer.slice(1);
  return hadMarkers
    ? `Updated agentbridge MCP in ${configPath} (peer=${peerLabel}).`
    : `Added agentbridge MCP to ${configPath} (peer=${peerLabel}). Restart Codex App to load it.`;
}

/**
 * Read config.toml and remove the agentbridge section if present.
 *
 * @returns A human-readable status string for logging, or null if nothing was removed.
 */
export function unpersistAgentBridgeMcp(): string | null {
  const configPath = codexConfigPath();
  let content = "";
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    return null; // no config file
  }

  if (!content.includes(MARKER_START)) {
    return null; // nothing to remove
  }

  const updated = removeAgentBridgeMcp(content);
  writeFileSync(configPath, updated, "utf-8");
  return `Removed agentbridge MCP from ${configPath}.`;
}
