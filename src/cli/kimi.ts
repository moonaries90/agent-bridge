import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";

/**
 * Resolve the daemon entry point.
 *
 * When running from source (bun link → dist/cli.js), DAEMON_PATH defaults to
 * "./daemon.ts" relative to the cli.js bundle — but dist/ doesn't contain
 * daemon.ts. We need to point to the actual source file.
 *
 * Strategy:
 * 1. If AGENTBRIDGE_DAEMON_ENTRY is already set (plugin environment), use it.
 * 2. Try ../src/daemon.ts relative to dist/cli.js (dev/source mode).
 * 3. Fall back to ./daemon.ts (plugin cache mode, where daemon.js is a sibling).
 */
function resolveDaemonEntry(): string {
  if (process.env.AGENTBRIDGE_DAEMON_ENTRY) return process.env.AGENTBRIDGE_DAEMON_ENTRY;

  // dist/cli.js → ../../src/daemon.ts (via bun link, package root is 2 levels up)
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(cliDir, "..", "src", "daemon.ts"),       // dist/ → ../src/daemon.ts
    join(cliDir, "..", "..", "src", "daemon.ts"),  // deeper nesting
    join(cliDir, "daemon.ts"),                      // sibling
    join(cliDir, "daemon.js"),                      // sibling (bundled)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to default (will be resolved by daemon-lifecycle)
  return "./daemon.ts";
}

/**
 * abg kimi — Start Claude Code bridged to Kimi Code CLI.
 *
 * This is a convenience command equivalent to:
 *   AGENTBRIDGE_PEER=kimi \
 *   AGENTBRIDGE_CONTROL_PORT=4602 \
 *   AGENTBRIDGE_STATE_DIR=~/.abck \
 *   abg claude
 *
 * Uses separate ports and state directory from `abg claude` (Codex mode),
 * so both can run simultaneously without conflict.
 *
 * Kimi is headless in this setup — the daemon spawns `kimi acp` directly.
 * There is no separate TUI to start.
 */

/** Flags that AgentBridge owns and will inject automatically. */
const OWNED_FLAGS = ["--channels", "--dangerously-load-development-channels"];

const KIMI_CONTROL_PORT = 4602;
const KIMI_STATE_DIR = join(homedir(), ".abck");

export async function runKimi(args: string[]) {
  // Check for owned flag conflicts
  for (const flag of OWNED_FLAGS) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) {
      console.error(`Error: "${flag}" is automatically set by abg kimi.`);
      process.exit(1);
    }
  }

  // Extract ACP permission flags consumed by abg kimi (NOT forwarded to claude):
  //   --yolo → kimi auto-approves all actions; --auto → kimi auto permission mode.
  // Headless ACP has no human approver, so without one of these kimi's internal
  // permission gate blocks Bash/tool calls.
  let acpPermArg: string | null = null;
  const claudeArgs: string[] = [];
  for (const a of args) {
    if (a === "--yolo" || a === "-y") acpPermArg = "--yolo";
    else if (a === "--auto") acpPermArg = "--auto";
    else claudeArgs.push(a);
  }

  // Set up Kimi-mode environment so the daemon and bridge pick up the right
  // adapter, ports, and state directory.
  process.env.AGENTBRIDGE_PEER = "kimi";
  process.env.AGENTBRIDGE_CONTROL_PORT = String(KIMI_CONTROL_PORT);
  process.env.AGENTBRIDGE_STATE_DIR = KIMI_STATE_DIR;
  process.env.AGENTBRIDGE_DAEMON_ENTRY = resolveDaemonEntry();
  // Pass the permission mode through to the `kimi acp` subprocess (read by KimiAdapter).
  if (acpPermArg) {
    process.env.KIMI_ACP_ARGS = acpPermArg;
  }

  const stateDir = new StateDirResolver(KIMI_STATE_DIR);
  stateDir.ensure();

  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort: KIMI_CONTROL_PORT,
    log: (msg) => console.error(`[abg kimi] ${msg}`),
  });

  lifecycle.clearKilled();

  // If a permission mode was requested, the daemon must be (re)started so the
  // KIMI_ACP_ARGS env reaches the `kimi acp` subprocess. A daemon already running
  // with the old env would otherwise be reused unchanged by ensureRunning().
  if (acpPermArg) {
    console.log(`[abg kimi] Permission mode "${acpPermArg}" requested — restarting daemon to apply...`);
    try {
      await lifecycle.kill();
    } catch (err: any) {
      console.error(`[abg kimi] daemon restart kill failed (continuing): ${err.message}`);
    }
  }

  // Ensure the Kimi-mode daemon is running before starting Claude.
  // The daemon will spawn `kimi acp` as its peer adapter.
  console.log(`[abg kimi] Starting Kimi-mode daemon on port ${KIMI_CONTROL_PORT}...`);

  // Workaround: bun may fail to spawn a detached daemon when cwd is the
  // agent-bridge project dir (loads project tsconfig/bunfig). Switch to a
  // neutral cwd for the daemon launch, then restore for Claude.
  const originalCwd = process.cwd();
  try {
    process.chdir(KIMI_STATE_DIR);
    // Belt-and-suspenders: clear the killed sentinel again right before
    // ensureRunning. The earlier clearKilled() at the top can be undone by a
    // stale sentinel written by `abg kill` between then and now, and daemon.ts
    // refuses to start (process.exit(0)) when the sentinel exists — manifesting
    // as a silent "Timed out waiting for readiness" with no daemon log entry.
    lifecycle.clearKilled();
    await lifecycle.ensureRunning();
    console.log(`[abg kimi] ✅ Daemon ready. Kimi adapter will spawn on first Claude connection.`);
  } catch (err: any) {
    console.error(`[abg kimi] ⚠️ Daemon startup: ${err.message}`);
    console.error(`[abg kimi] Claude will start anyway — daemon may connect later.`);
  } finally {
    process.chdir(originalCwd);
  }

  const channelEntry = `plugin:${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  const fullArgs = [
    "--dangerously-load-development-channels", channelEntry,
    ...claudeArgs,
  ];

  console.log(`[abg kimi] Starting Claude Code (state dir: ${KIMI_STATE_DIR})...`);

  const child = spawn("claude", fullArgs, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: claude not found in PATH.");
      console.error("Install Claude Code: npm install -g @anthropic-ai/claude-code");
      process.exit(1);
    }
    console.error(`Error starting Claude Code: ${err.message}`);
    process.exit(1);
  });
}
