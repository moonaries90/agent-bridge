import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { StateDirResolver } from "../state-dir";
import { DaemonLifecycle, isProcessAlive } from "../daemon-lifecycle";

export async function runKill() {
  console.log("AgentBridge Kill — stopping all daemons and cleaning up all processes\n");

  // All known daemon instances. Each entry: state dir + control port + label.
  // Adding a new mode here is sufficient for `abg kill` to cover it.
  const instances: Array<{ stateDir: StateDirResolver; port: number; label: string }> = [
    // 1. Claude+Codex mode (port 4502, default state dir)
    {
      stateDir: new StateDirResolver(),
      port: parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10),
      label: "Codex",
    },
    // 2. Claude+Kimi mode (port 4602, ~/.abck state dir)
    {
      stateDir: new StateDirResolver(join(homedir(), ".abck")),
      port: 4602,
      label: "Kimi",
    },
    // 3. Codex+Kimi mode (port 4603, ~/.abck-codex state dir)
    {
      stateDir: new StateDirResolver(join(homedir(), ".abck-codex")),
      port: 4603,
      label: "CodexKimi",
    },
    // 4. Claude+ZCode mode (port 4702, ~/.abcz state dir)
    {
      stateDir: new StateDirResolver(join(homedir(), ".abcz")),
      port: 4702,
      label: "ZCode",
    },
    // 5. Codex+ZCode mode (port 4703, ~/.abcz-codex state dir)
    {
      stateDir: new StateDirResolver(join(homedir(), ".abcz-codex")),
      port: 4703,
      label: "CodexZCode",
    },
  ];

  let anyKilled = false;
  for (const inst of instances) {
    anyKilled = (await killOneDaemon(inst.stateDir, inst.port, inst.label)) || anyKilled;
  }

  // Sweep: kill ALL agentbridge-related processes that are not tracked by pid
  // files. This catches orphaned processes that the pid-file-based cleanup
  // above misses:
  //   - codex-bridge-mcp.ts (MCP child spawned by codex, no pid file)
  //   - bridge-server.js / bridge.ts (Claude-side MCP frontend)
  //   - daemon.ts processes launched manually or without a pid file
  //   - "abg <command>" wrapper processes still alive
  //
  // We match on command-line patterns rather than pid files because these
  // processes are spawned by external tools (codex, claude) that don't write
  // into our state dir. The patterns are specific enough to avoid false
  // positives on unrelated processes.
  const strayCount = killStrayProcesses();

  // Remove the agentbridge MCP section from ~/.codex/config.toml so the Codex
  // desktop App (which reads config.toml on startup) no longer tries to spawn
  // the agentbridge MCP server. This makes `abg kill` a true "clean slate" —
  // re-run `abg init` or `abg codex-zcode --persist` to restore it.
  let configCleaned = false;
  try {
    const { unpersistAgentBridgeMcp } = await import("../codex-config");
    const msg = unpersistAgentBridgeMcp();
    if (msg) {
      console.log(`\n  ${msg}`);
      configCleaned = true;
    }
  } catch {
    // best-effort — don't fail kill if config cleanup has issues
  }

  if (anyKilled || strayCount > 0 || configCleaned) {
    const parts: string[] = [];
    if (anyKilled) parts.push("daemons killed");
    if (strayCount > 0) parts.push(`${strayCount} stray process(es) cleaned`);
    if (configCleaned) parts.push("config.toml cleaned");
    console.log(`\nAgentBridge stopped (${parts.join(", ")}).`);
    console.log("Please restart (`abg claude`, `abg kimi`, `abg codex-kimi`, `abg zcode`, or `abg codex-zcode`), switch to a new conversation, or run `/resume` to fully disconnect.");
  } else {
    console.log("\nNo running AgentBridge daemon or managed Codex TUI found.");
    console.log("Stale state files cleaned up (if any).");
  }
}

/**
 * Find and kill ALL agentbridge-related processes by scanning the process
 * table. Returns the number of processes killed.
 *
 * Pattern matching is done on the full command line (`ps -axo pid=,command=`)
 * so we catch processes regardless of how they were launched. Each pattern is
 * specific to agentbridge's own file/process names to avoid killing unrelated
 * work (e.g. the user's editor open on agentbridge source).
 */
function killStrayProcesses(): number {
  // Patterns that uniquely identify agentbridge processes by command line.
  // Each is a substring of the full `ps command=` output.
  // IMPORTANT: these are matched on the process's OWN command line (the
  // executable + its args), NOT on arbitrary text that happens to mention the
  // path. We explicitly skip shell wrapper processes (zsh/bash/sh -c '...')
  // because their command line is a script body that may mention these paths
  // without the process actually being an agentbridge component.
  const patterns = [
    "agent-bridge/src/daemon.ts",        // daemon (any mode, any launch method)
    "agent-bridge/src/codex-bridge-mcp.ts", // Codex-side MCP server
    "agent-bridge/src/bridge.ts",         // Claude-side MCP frontend (dev)
    "agentbridge/server/bridge-server.js", // Claude-side MCP frontend (plugin)
  ];

  // Shell interpreters: if a process's executable is one of these, it's a
  // wrapper script (e.g. `zsh -c '...'`), not an agentbridge process itself.
  // Its command line may contain agentbridge paths as part of the script text.
  const shellBins = new Set(["zsh", "bash", "sh", "dash", "fish"]);

  // The "abg <command>" wrapper: match "abg" as the executable followed by a
  // known subcommand, so we don't kill an unrelated binary also named "abg".
  const abgCommands = ["abg claude", "abg codex", "abg kimi", "abg zcode", "abg codex-kimi", "abg codex-zcode"];

  let pids = new Set<number>();

  // Gather process list with both pid, comm (executable basename), and full
  // command. comm lets us skip shell wrappers; command has the full args.
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,comm=,command="], { encoding: "utf-8" });
  } catch {
    return 0;
  }

  const ownPid = process.pid;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Parse: "<pid> <comm> <command...>". comm has no spaces (it's a basename),
    // and command is the rest of the line.
    const pidMatch = trimmed.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1], 10);
    const comm = pidMatch[2];
    const cmd = pidMatch[3];

    // Never kill ourselves.
    if (pid === ownPid) continue;

    // Skip shell wrapper processes — their command line is a script body that
    // may reference agentbridge paths without being an agentbridge process.
    const commBase = comm.split("/").pop() ?? comm;
    if (shellBins.has(commBase)) continue;

    let matched = false;
    for (const pat of patterns) {
      if (cmd.includes(pat)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const abgCmd of abgCommands) {
        // Match "bun .../abg codex-zcode" or "abg codex-zcode" as the command.
        if (cmd.includes(abgCmd)) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      pids.add(pid);
    }
  }

  if (pids.size === 0) return 0;

  // Report what we found, then kill.
  console.log(`\n  [stray] Found ${pids.size} agentbridge process(es) not tracked by pid files:`);
  for (const pid of pids) {
    try {
      const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
      console.log(`  [stray]   PID ${pid}: ${truncate(cmd, 90)}`);
    } catch {
      // process may have already exited
    }
  }

  // SIGTERM first (graceful).
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }

  // Force-kill anything still alive after a brief grace period. We poll a few
  // times with short sync delays (Atomics.wait) to give processes time to
  // shut down gracefully before escalating to SIGKILL.
  const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 4; i++) {
    sleepMs(250);
    let anyAlive = false;
    for (const pid of pids) {
      if (isProcessAlive(pid)) { anyAlive = true; break; }
    }
    if (!anyAlive) break;
  }

  // Force-kill anything still alive.
  let killed = 0;
  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already dead */ }
    }
    killed++;
  }

  if (killed > 0) {
    console.log(`  [stray] Cleaned up ${killed} process(es).`);
  }
  return killed;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Kill one daemon instance (given its state dir and control port). */
async function killOneDaemon(
  stateDir: StateDirResolver,
  controlPort: number,
  label: string,
): Promise<boolean> {
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.log(`  [${label}] ${msg}`),
  });

  lifecycle.markKilled();
  const tuiKilled = label === "Codex"
    ? await killManagedCodexTui(stateDir, (msg) => console.log(`  [${label}] ${msg}`))
    : false;
  const killed = await lifecycle.kill();
  return killed || tuiKilled;
}

async function killManagedCodexTui(
  stateDir: StateDirResolver,
  log: (msg: string) => void,
  gracefulTimeoutMs = 3000,
): Promise<boolean> {
  const pid = readTuiPid(stateDir);
  if (!pid) {
    log("No Codex TUI pid file found");
    removeTuiPidFile(stateDir);
    return false;
  }

  if (!isProcessAlive(pid)) {
    log(`Codex TUI pid ${pid} is not alive, cleaning up stale pid file`);
    removeTuiPidFile(stateDir);
    return false;
  }

  if (!isManagedCodexTuiProcess(pid)) {
    log(`Pid ${pid} is alive but is NOT a managed AgentBridge Codex TUI — refusing to kill. Cleaning up stale pid file.`);
    removeTuiPidFile(stateDir);
    return false;
  }

  log(`Sending SIGTERM to Codex TUI pid ${pid}`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removeTuiPidFile(stateDir);
    return false;
  }

  const deadline = Date.now() + gracefulTimeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      log(`Codex TUI pid ${pid} stopped gracefully`);
      removeTuiPidFile(stateDir);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  log(`Codex TUI pid ${pid} did not stop gracefully, sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}

  removeTuiPidFile(stateDir);
  return true;
}

function readTuiPid(stateDir: StateDirResolver): number | null {
  try {
    const raw = readFileSync(stateDir.tuiPidFile, "utf-8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function removeTuiPidFile(stateDir: StateDirResolver) {
  try {
    unlinkSync(stateDir.tuiPidFile);
  } catch {}
}

function isManagedCodexTuiProcess(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
    return (
      cmd.includes("codex")
      && cmd.includes("--enable")
      && cmd.includes("tui_app_server")
      && cmd.includes("--remote")
    );
  } catch {
    return false;
  }
}
