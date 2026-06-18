#!/usr/bin/env bun

/**
 * AgentBridge CLI
 *
 * Commands:
 *   agentbridge init        — Install plugin, check deps, generate project config
 *   agentbridge dev         — Register local marketplace + install plugin for local dev
 *   agentbridge claude      — Start Claude Code with push channel flags
 *   agentbridge codex       — Start Codex TUI connected to daemon
 *   agentbridge kimi        — Start Claude Code bridged to Kimi
 *   agentbridge codex-kimi  — Start Codex CLI bridged to Kimi
 *   agentbridge zcode       — Start Claude Code bridged to ZCode (headless)
 *   agentbridge codex-zcode — Start Codex CLI bridged to ZCode (headless)
 *   agentbridge kill        — Force kill all AgentBridge processes
 */

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

// Marketplace name constant (shared with plugin)
export const MARKETPLACE_NAME = "agentbridge";
export const PLUGIN_NAME = "agentbridge";

async function main() {
  switch (command) {
    case "init":
      const { runInit } = await import("./cli/init");
      await runInit();
      break;
    case "dev":
      const { runDev } = await import("./cli/dev");
      await runDev();
      break;
    case "claude":
      const { runClaude } = await import("./cli/claude");
      await runClaude(restArgs);
      break;
    case "codex":
      const { runCodex } = await import("./cli/codex");
      await runCodex(restArgs);
      break;
    case "kimi":
      const { runKimi } = await import("./cli/kimi");
      await runKimi(restArgs);
      break;
    case "codex-kimi":
      const { runCodexKimi } = await import("./cli/codex-kimi");
      await runCodexKimi(restArgs);
      break;
    case "zcode":
      const { runZcode } = await import("./cli/zcode");
      await runZcode(restArgs);
      break;
    case "codex-zcode":
      const { runCodexZcode } = await import("./cli/codex-zcode");
      await runCodexZcode(restArgs);
      break;
    case "kill":
      const { runKill } = await import("./cli/kill");
      await runKill();
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    case "--version":
    case "-v":
      printVersion();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run "agentbridge --help" (or "abg --help") for usage.`);
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
AgentBridge — Multi-agent collaboration bridge

Usage:
  agentbridge <command> [args...]
  abg <command> [args...]

Commands:
  init              Install plugin, check dependencies, generate project config
  dev               Register local marketplace + install plugin (for local dev)
  claude [args...]  Start Claude Code with push channel enabled (Codex peer)
  codex [args...]   Start Codex TUI connected to AgentBridge daemon
  kimi [args...]    Start Claude Code bridged to Kimi Code CLI (headless, port 4602)
  codex-kimi [args...] Start Codex CLI bridged to Kimi Code CLI (headless, port 4603)
  zcode [args...]   Start Claude Code bridged to ZCode CLI (headless, port 4702)
  codex-zcode [args...] Start Codex CLI bridged to ZCode CLI (headless, port 4703)
  kill              Force kill all AgentBridge processes

Options:
  --help, -h        Show this help message
  --version, -v     Show version

Examples:
  abg init                     # First-time setup
  abg claude                   # Start Claude Code (with Codex bridge)
  abg claude --resume          # Start Claude Code and resume session
  abg codex                    # Start Codex TUI
  abg codex --model o3         # Start Codex with specific model
  abg kimi                     # Start Claude Code bridged to Kimi (headless)
  abg codex-kimi               # Start Codex CLI bridged to Kimi (headless)
  abg zcode                    # Start Claude Code bridged to ZCode (headless)
  abg codex-zcode              # Start Codex CLI bridged to ZCode (headless)
                               # ZCode replies are injected into Codex in real time (no polling)
  abg kill                     # Emergency: kill all processes
`.trim());
}

function printVersion() {
  try {
    const pkg = require("../package.json");
    console.log(`agentbridge v${pkg.version}`);
  } catch {
    console.log("agentbridge (version unknown)");
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
