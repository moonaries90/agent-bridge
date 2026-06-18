import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";

/**
 * Resolve a source file relative to the package root (same strategy as
 * codex-zcode.ts).
 */
function resolveSourceFile(name: string): string {
  if (process.env.AGENTBRIDGE_DAEMON_ENTRY) {
    const daemonDir = dirname(process.env.AGENTBRIDGE_DAEMON_ENTRY);
    const candidate = join(daemonDir, name);
    if (existsSync(candidate)) return candidate;
  }
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(cliDir, "..", name),
    join(cliDir, "..", "src", name),
    join(cliDir, "..", "..", "src", name),
    join(cliDir, name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(cliDir, name);
}

/**
 * abg codex-kimi — Start Codex CLI (controller) bridged to Kimi Code (peer).
 *
 * Symmetric to `abg kimi` (Claude controller + Kimi headless), but with Codex as
 * the controller. Uses the same controller-middleman architecture as
 * codex-zcode: the daemon proxies the controller's Codex TUI ↔ its app-server so
 * it can inject Kimi's replies as real `turn/start` turns (real-time, no
 * polling). See cli/codex-zcode.ts for the full rationale.
 *
 * Internally:
 *   AGENTBRIDGE_PEER=kimi
 *   AGENTBRIDGE_CONTROLLER=codex
 *   AGENTBRIDGE_CONTROL_PORT=4603        (distinct from abg kimi's 4602)
 *   AGENTBRIDGE_STATE_DIR=~/.abck-codex  (distinct from abg kimi's ~/.abck)
 */

const KIMI_CONTROL_PORT = 4603;
const KIMI_STATE_DIR = join(homedir(), ".abck-codex");
// Controller-middleman ports for codex-kimi (distinct from codex-zcode's so both
// can run side by side).
const CONTROLLER_APP_PORT = 4730;
const CONTROLLER_PROXY_PORT = 4731;

export async function runCodexKimi(args: string[]) {
  // Kimi permission flags are consumed here (NOT forwarded to codex):
  //   --yolo → kimi auto-approves all actions; --auto → kimi auto permission mode.
  // Headless ACP has no human approver, so without one of these kimi's internal
  // permission gate blocks Bash/tool calls.
  let acpPermArg: string | null = null;
  const codexArgs: string[] = [];
  for (const a of args) {
    if (a === "--yolo" || a === "-y") acpPermArg = "--yolo";
    else if (a === "--auto") acpPermArg = "--auto";
    else codexArgs.push(a);
  }

  // Kimi-mode environment, inherited by the detached daemon (DaemonLifecycle
  // spawns it with { ...process.env }).
  process.env.AGENTBRIDGE_PEER = "kimi";
  process.env.AGENTBRIDGE_CONTROL_PORT = String(KIMI_CONTROL_PORT);
  process.env.AGENTBRIDGE_STATE_DIR = KIMI_STATE_DIR;
  process.env.AGENTBRIDGE_DAEMON_ENTRY = resolveSourceFile("daemon.ts");
  process.env.AGENTBRIDGE_RESTART_CMD = "abg codex-kimi";
  if (acpPermArg) {
    process.env.KIMI_ACP_ARGS = acpPermArg;
  }

  // The user's real cwd, captured BEFORE the chdir workaround below. The daemon
  // is spawned with cwd=state-dir (workaround), so without this the peer + the
  // controller's app-server would run in ~/.abck-codex instead of here.
  const userCwd = process.cwd();
  process.env.AGENTBRIDGE_WORK_DIR = userCwd; // controller (codex app-server) cwd
  process.env.KIMI_WORK_DIR = userCwd;        // peer (kimi acp) cwd

  // Controller-middleman mode (real-time turn injection, no polling).
  process.env.AGENTBRIDGE_CONTROLLER = "codex";
  process.env.AGENTBRIDGE_CONTROLLER_APP_PORT = String(CONTROLLER_APP_PORT);
  process.env.AGENTBRIDGE_CONTROLLER_PROXY_PORT = String(CONTROLLER_PROXY_PORT);

  const bridgeScript = resolveSourceFile("codex-bridge-mcp.ts");
  // Tell the daemon where the bridge MCP lives so it can mount the `reply` tool
  // on the controller's app-server via `-c` (no global config.toml pollution).
  // Skip when config.toml already provides agentbridge (avoid a duplicate child).
  const { hasAgentBridgeMcp } = await import("../codex-config");
  if (!hasAgentBridgeMcp()) {
    process.env.AGENTBRIDGE_BRIDGE_SCRIPT = bridgeScript;
  } else {
    console.log(`[abg codex-kimi] config.toml already provides agentbridge MCP — middleman app-server will load it from there.`);
  }

  const stateDir = new StateDirResolver(KIMI_STATE_DIR);
  stateDir.ensure();

  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort: KIMI_CONTROL_PORT,
    log: (msg) => console.error(`[abg codex-kimi] ${msg}`),
  });

  lifecycle.clearKilled();

  // Reuse a running daemon already in controller-middleman mode (preserves the
  // live session on reconnect); otherwise restart so the new env applies. A
  // requested permission mode also forces a restart (so KIMI_ACP_ARGS reaches
  // the `kimi acp` subprocess).
  const existingStatus = lifecycle.readStatus();
  const healthy = await lifecycle.isHealthy().catch(() => false);
  const alreadyControllerMode = !!existingStatus?.controllerProxyUrl && healthy;
  if (alreadyControllerMode && !acpPermArg) {
    console.log(`[abg codex-kimi] Reusing running controller-middleman daemon (control port ${KIMI_CONTROL_PORT}).`);
  } else {
    console.log(`[abg codex-kimi] (Re)starting Kimi-mode daemon to apply controller-middleman config...`);
    try {
      await lifecycle.kill();
    } catch (err: any) {
      console.error(`[abg codex-kimi] daemon restart kill failed (continuing): ${err.message}`);
    }
  }

  // Workaround: bun may fail to spawn a detached daemon when cwd is the
  // agent-bridge project dir. Switch to a neutral cwd for the daemon launch.
  const originalCwd = process.cwd();
  try {
    process.chdir(KIMI_STATE_DIR);
    lifecycle.clearKilled();
    await lifecycle.ensureRunning();
    console.log(`[abg codex-kimi] ✅ Daemon ready (control port ${KIMI_CONTROL_PORT}).`);
  } catch (err: any) {
    console.error(`[abg codex-kimi] ⚠️ Daemon startup: ${err.message}`);
    console.error(`[abg codex-kimi] Codex will start anyway — daemon may connect later.`);
  } finally {
    process.chdir(originalCwd);
  }

  // The daemon opens the controller middleman proxy and records its URL in
  // status.json. Wait for it, then point the TUI there via `--remote`.
  let controllerProxyUrl: string | undefined;
  for (let i = 0; i < 50; i++) {
    const status = lifecycle.readStatus();
    if (status?.controllerProxyUrl) {
      controllerProxyUrl = status.controllerProxyUrl;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!controllerProxyUrl) {
    controllerProxyUrl = `ws://127.0.0.1:${CONTROLLER_PROXY_PORT}`;
    console.error(`[abg codex-kimi] ⚠️ controller proxy URL not in daemon status; using default ${controllerProxyUrl}`);
  }

  const fullArgs = [
    "--enable", "tui_app_server",
    "--remote", controllerProxyUrl,
    ...codexArgs,
  ];

  console.log(`[abg codex-kimi] Connecting Codex TUI to controller middleman at ${controllerProxyUrl} (peer: Kimi)...`);

  const child = spawn("codex", fullArgs, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: codex not found in PATH.");
      console.error("Install Codex: https://github.com/openai/codex");
      process.exit(1);
    }
    console.error(`Error starting Codex: ${err.message}`);
    process.exit(1);
  });
}
