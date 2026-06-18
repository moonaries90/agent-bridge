import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StateDirResolver } from "../state-dir";

/**
 * Resolve a source file relative to the package root.
 *
 * Same resolution strategy as codex-kimi.ts.
 */
function resolveSourceFile(name: string): string {
  if (process.env.AGENTBRIDGE_DAEMON_ENTRY) {
    const daemonDir = dirname(process.env.AGENTBRIDGE_DAEMON_ENTRY);
    const candidate = join(daemonDir, name);
    if (existsSync(candidate)) return candidate;
  }
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(cliDir, "..", name),            // src/cli/ → ../<name> (dev)
    join(cliDir, "..", "src", name),     // dist/ → ../src/<name>
    join(cliDir, "..", "..", "src", name),
    join(cliDir, name),                  // sibling (bundled plugin mode)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(cliDir, name);
}

/**
 * abg codex-zcode — Start Codex CLI (controller) bridged to ZCode CLI (peer).
 *
 * Symmetric to `abg zcode` (Claude controller + ZCode headless), but with Codex
 * as the controller instead of Claude.
 *
 * ## Controller-middleman architecture (real-time, no polling)
 *
 * Codex's MCP client never surfaces server-pushed notifications into the model's
 * context, so an MCP-only controller can only POLL (get_messages) — which wastes
 * turns. To deliver ZCode's replies in real time we instead run the controller
 * Codex through an AgentBridge **middleman**, exactly like `abg codex` does for
 * the controlled side:
 *
 *   Codex TUI ──(--remote ws)──▶ CodexAdapter middleman (in daemon) ──▶ codex app-server
 *
 * The daemon owns that app-server, so it can inject ZCode's replies as real
 * `turn/start` turns into the controller's thread (they appear in context
 * immediately). SEND stays explicit via the `reply` MCP tool, which the daemon
 * mounts onto the middleman's app-server via `-c` (so no ~/.codex/config.toml
 * pollution). The TUI launched here is a thin `--remote` frontend.
 *
 * Internally:
 *   AGENTBRIDGE_PEER=zcode
 *   AGENTBRIDGE_CONTROLLER=codex         (tells the daemon to start the middleman)
 *   AGENTBRIDGE_CONTROL_PORT=4703        (distinct from abg zcode's 4702)
 *   AGENTBRIDGE_STATE_DIR=~/.abcz-codex  (distinct from abg zcode's ~/.abcz)
 */

const ZCODE_CONTROL_PORT = 4703;
const ZCODE_STATE_DIR = join(homedir(), ".abcz-codex");
// Controller-middleman ports for codex-zcode (distinct from codex-kimi's so both
// can run side by side).
const CONTROLLER_APP_PORT = 4720;
const CONTROLLER_PROXY_PORT = 4721;

export async function runCodexZcode(args: string[]) {
  // ZCode session mode is consumed here (NOT forwarded to codex):
  //   --yolo / --mode yolo  → auto-approve all actions (default)
  //   --mode build|edit|plan → tighter permission mode
  //   --persist → deprecated in controller-middleman mode (see warning below)
  let sessionMode = "yolo";
  let persistToConfig = false;
  const codexArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yolo" || a === "-y") {
      sessionMode = "yolo";
    } else if (a === "--mode" && i + 1 < args.length) {
      sessionMode = args[++i];
    } else if (a.startsWith("--mode=")) {
      sessionMode = a.slice("--mode=".length);
    } else if (a === "--persist") {
      persistToConfig = true;
    } else {
      codexArgs.push(a);
    }
  }

  // Set up ZCode-mode environment so the daemon picks up the right peer adapter,
  // ports, and state directory. Inherited by the detached daemon (DaemonLifecycle
  // spawns it with { ...process.env }).
  process.env.AGENTBRIDGE_PEER = "zcode";
  process.env.AGENTBRIDGE_CONTROL_PORT = String(ZCODE_CONTROL_PORT);
  process.env.AGENTBRIDGE_STATE_DIR = ZCODE_STATE_DIR;
  process.env.AGENTBRIDGE_DAEMON_ENTRY = resolveSourceFile("daemon.ts");
  process.env.ZCODE_SESSION_MODE = sessionMode;
  process.env.AGENTBRIDGE_RESTART_CMD = "abg codex-zcode";

  // The user's real cwd, captured BEFORE the chdir workaround below. The daemon
  // is spawned with cwd=state-dir (workaround), so without this the peer + the
  // controller's app-server would run in ~/.abcz-codex instead of here.
  const userCwd = process.cwd();
  process.env.AGENTBRIDGE_WORK_DIR = userCwd; // controller (codex app-server) cwd
  process.env.ZCODE_WORK_DIR = userCwd;       // peer (zcode app-server) cwd

  // Controller-middleman mode: the daemon starts a CodexAdapter for the
  // controller Codex and injects ZCode replies as real turns (no polling).
  process.env.AGENTBRIDGE_CONTROLLER = "codex";
  process.env.AGENTBRIDGE_CONTROLLER_APP_PORT = String(CONTROLLER_APP_PORT);
  process.env.AGENTBRIDGE_CONTROLLER_PROXY_PORT = String(CONTROLLER_PROXY_PORT);

  const bridgeScript = resolveSourceFile("codex-bridge-mcp.ts");
  // Tell the daemon where the bridge MCP lives so it can mount the `reply` tool
  // on the controller's app-server via `-c`. Skip when config.toml already
  // provides agentbridge (avoids a duplicate MCP child in the middleman).
  const { hasAgentBridgeMcp } = await import("../codex-config");
  if (!hasAgentBridgeMcp()) {
    process.env.AGENTBRIDGE_BRIDGE_SCRIPT = bridgeScript;
  } else {
    console.log(`[abg codex-zcode] config.toml already provides agentbridge MCP — middleman app-server will load it from there.`);
  }

  const stateDir = new StateDirResolver(ZCODE_STATE_DIR);
  stateDir.ensure();

  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort: ZCODE_CONTROL_PORT,
    log: (msg) => console.error(`[abg codex-zcode] ${msg}`),
  });

  lifecycle.clearKilled();

  // The controller-middleman + session mode are baked into the daemon at launch
  // (env-driven). Reuse a running daemon that's already in controller-middleman
  // mode (preserves the live session on reconnect); otherwise restart so the
  // new env applies. A non-default session mode also forces a restart.
  const existingStatus = lifecycle.readStatus();
  const healthy = await lifecycle.isHealthy().catch(() => false);
  const alreadyControllerMode = !!existingStatus?.controllerProxyUrl && healthy;
  if (alreadyControllerMode && sessionMode === "yolo") {
    console.log(`[abg codex-zcode] Reusing running controller-middleman daemon (control port ${ZCODE_CONTROL_PORT}).`);
  } else {
    console.log(`[abg codex-zcode] (Re)starting ZCode-mode daemon to apply controller-middleman config...`);
    try {
      await lifecycle.kill();
    } catch (err: any) {
      console.error(`[abg codex-zcode] daemon restart kill failed (continuing): ${err.message}`);
    }
  }

  // Workaround: bun may fail to spawn a detached daemon when cwd is the
  // agent-bridge project dir. Switch to a neutral cwd for the daemon launch.
  const originalCwd = process.cwd();
  try {
    process.chdir(ZCODE_STATE_DIR);
    lifecycle.clearKilled();
    await lifecycle.ensureRunning();
    console.log(`[abg codex-zcode] ✅ Daemon ready (control port ${ZCODE_CONTROL_PORT}).`);
  } catch (err: any) {
    console.error(`[abg codex-zcode] ⚠️ Daemon startup: ${err.message}`);
    console.error(`[abg codex-zcode] Codex will start anyway — daemon may connect later.`);
  } finally {
    process.chdir(originalCwd);
  }

  if (persistToConfig) {
    console.log(`[abg codex-zcode] --persist is ignored in controller-middleman mode (the reply tool is mounted on the middleman's app-server via -c, not config.toml).`);
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
    console.error(`[abg codex-zcode] ⚠️ controller proxy URL not in daemon status; using default ${controllerProxyUrl}`);
  }

  const fullArgs = [
    "--enable", "tui_app_server",
    "--remote", controllerProxyUrl,
    ...codexArgs,
  ];

  console.log(`[abg codex-zcode] Connecting Codex TUI to controller middleman at ${controllerProxyUrl} (peer: ZCode)...`);

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
