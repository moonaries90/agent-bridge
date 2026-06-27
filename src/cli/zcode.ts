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
 * Same strategy as kimi.ts: when running from dist/cli.js (bun link), the
 * source daemon.ts is two levels up. When running from src/cli/ (dev), it's a
 * sibling of cli/.
 */
function resolveDaemonEntry(): string {
  if (process.env.AGENTBRIDGE_DAEMON_ENTRY) return process.env.AGENTBRIDGE_DAEMON_ENTRY;

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
  return "./daemon.ts";
}

/**
 * abg zcode — Start Claude Code bridged to ZCode CLI (headless).
 *
 * Equivalent to:
 *   AGENTBRIDGE_PEER=zcode \
 *   AGENTBRIDGE_CONTROL_PORT=4702 \
 *   AGENTBRIDGE_STATE_DIR=~/.abcz \
 *   abg claude
 *
 * Uses separate ports and state directory from `abg claude` (Codex) and
 * `abg kimi`, so all three can run simultaneously without conflict.
 *
 * ZCode is headless in this setup — the daemon spawns `zcode app-server
 * --stdio` directly. There is no separate TUI to start (ZCode's TUI has no
 * --remote attach mode, so the codex-style middleman isn't possible).
 *
 * The ZCode agent binary is NOT on PATH by default — it lives at
 * ~/.zcode/server/agents/glm/zcode-agent. Override with ZCODE_BIN.
 */

/** Flags that AgentBridge owns and will inject automatically. */
const OWNED_FLAGS = ["--channels", "--dangerously-load-development-channels"];

const ZCODE_CONTROL_PORT = 4702;
const ZCODE_STATE_DIR = join(homedir(), ".abcz");

export async function runZcode(args: string[]) {
  // Check for owned flag conflicts
  for (const flag of OWNED_FLAGS) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) {
      console.error(`Error: "${flag}" is automatically set by abg zcode.`);
      process.exit(1);
    }
  }

  // ZCode session mode is consumed here (NOT forwarded to claude):
  //   --yolo / --mode yolo  → auto-approve all actions (default for headless)
  //   --mode build|edit|plan → tighter permission mode (adapter still auto-grants
  //                            interaction/requestPermission, but the agent's own
  //                            mode affects how it plans tool use).
  // Headless has no human approver, so default to yolo unless overridden.
  let sessionMode = "yolo";
  const claudeArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yolo" || a === "-y") {
      sessionMode = "yolo";
    } else if (a === "--mode" && i + 1 < args.length) {
      sessionMode = args[++i];
    } else if (a.startsWith("--mode=")) {
      sessionMode = a.slice("--mode=".length);
    } else {
      claudeArgs.push(a);
    }
  }

  // Set up ZCode-mode environment so the daemon and bridge pick up the right
  // adapter, ports, and state directory.
  process.env.AGENTBRIDGE_PEER = "zcode";
  process.env.AGENTBRIDGE_CONTROL_PORT = String(ZCODE_CONTROL_PORT);
  process.env.AGENTBRIDGE_STATE_DIR = ZCODE_STATE_DIR;
  process.env.AGENTBRIDGE_DAEMON_ENTRY = resolveDaemonEntry();
  // Pass the session mode through to the `zcode app-server` subprocess
  // (read by ZcodeAdapter.createSession).
  process.env.ZCODE_SESSION_MODE = sessionMode;

  // The user's real cwd, captured BEFORE the chdir workaround below. The daemon
  // is spawned with cwd=ZCODE_STATE_DIR (~/.abcz) as a bun-spawn workaround and
  // inherits that cwd; the ZcodeAdapter then spawns the peer with
  // `ZCODE_WORK_DIR ?? process.cwd()`. Without this, the ZCode peer would run in
  // ~/.abcz (the state/log dir) instead of the user's project. Mirrors
  // codex-zcode.ts, which sets the same var.
  process.env.ZCODE_WORK_DIR = process.cwd();

  const stateDir = new StateDirResolver(ZCODE_STATE_DIR);
  stateDir.ensure();

  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort: ZCODE_CONTROL_PORT,
    log: (msg) => console.error(`[abg zcode] ${msg}`),
  });

  lifecycle.clearKilled();

  // If a non-default mode was requested, the daemon must be (re)started so the
  // ZCODE_SESSION_MODE env reaches the `zcode app-server` subprocess.
  if (sessionMode !== "yolo") {
    console.log(`[abg zcode] Session mode "${sessionMode}" requested — restarting daemon to apply...`);
    try {
      await lifecycle.kill();
    } catch (err: any) {
      console.error(`[abg zcode] daemon restart kill failed (continuing): ${err.message}`);
    }
  }

  // Ensure the ZCode-mode daemon is running before starting Claude.
  console.log(`[abg zcode] Starting ZCode-mode daemon on port ${ZCODE_CONTROL_PORT}...`);

  // Workaround: bun may fail to spawn a detached daemon when cwd is the
  // agent-bridge project dir (loads project tsconfig/bunfig). Switch to a
  // neutral cwd for the daemon launch, then restore for Claude.
  const originalCwd = process.cwd();
  try {
    process.chdir(ZCODE_STATE_DIR);
    // Belt-and-suspenders: clear the killed sentinel again right before
    // ensureRunning. See kimi.ts for rationale.
    lifecycle.clearKilled();
    await lifecycle.ensureRunning();
    console.log(`[abg zcode] ✅ Daemon ready. ZCode adapter will spawn on first Claude connection.`);
  } catch (err: any) {
    console.error(`[abg zcode] ⚠️ Daemon startup: ${err.message}`);
    console.error(`[abg zcode] Claude will start anyway — daemon may connect later.`);
  } finally {
    process.chdir(originalCwd);
  }

  const channelEntry = `plugin:${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  const fullArgs = [
    "--dangerously-load-development-channels", channelEntry,
    ...claudeArgs,
  ];

  console.log(`[abg zcode] Starting Claude Code (state dir: ${ZCODE_STATE_DIR})...`);

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
