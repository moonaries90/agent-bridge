# AgentBridge — Multi-Agent Collaboration Bridge

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文文档](README.zh-CN.md)

> **Acknowledgement.** This repository (`agent-collaboration`) is a personal, heavily modified
> fork of [**AgentBridge** by Rayson (@raysonmeng)](https://github.com/raysonmeng/agent-bridge),
> created with deep respect for the original author's work. Because the changes diverge
> substantially from upstream — turning a Claude⇄Codex bridge into a multi-agent one (adding
> Kimi and ZCode peers, Codex-as-controller, and real-time reply injection) — it is maintained
> as a separate project rather than submitted back as a PR. The original MIT license and
> copyright are retained in full. See [Acknowledgements](#acknowledgements) for credit.

Run two coding agents side by side in the **same working session**, on your own machine, talking
to each other in real time. You drive one agent interactively — the **controller** (Claude Code
or Codex) — while a second agent — the **peer** (Codex, Kimi, or ZCode) — is bridged in: its
messages are pushed to the controller, and the controller's replies are injected back into the
peer. A human stays in the loop, assigning work and reviewing both sides.

## What this project is / is not

**It is:**

- A local developer tool for pairing two AI coding agents in one workflow
- A bridge that forwards messages between an MCP channel and each peer's native protocol
  (Codex app-server, Kimi ACP, ZCode app-server)
- An experimental setup for human-in-the-loop, cross-vendor agent collaboration

**It is not:**

- A hosted service or multi-tenant system
- A generic orchestration framework for arbitrary agent backends
- A hardened security boundary between tools you do not trust

## Supported pairings

Each command pairs a controller with a peer. Pairings use **separate ports and state
directories**, so several can run at once without conflict.

| Command(s) | Controller | Peer | Peer runtime | Control port |
|------------|------------|------|--------------|--------------|
| `abg claude` + `abg codex` | Claude Code | Codex | Codex TUI via local proxy | `4502` |
| `abg kimi` | Claude Code | Kimi | headless (`kimi acp`) | `4602` |
| `abg codex-kimi` | Codex | Kimi | headless (`kimi acp`) | `4603` |
| `abg zcode` | Claude Code | ZCode | headless (`zcode app-server --stdio`) | `4702` |
| `abg codex-zcode` | Codex | ZCode | headless (`zcode app-server --stdio`) | `4703` |

> **Headless vs. TUI.** The Codex pairing runs Codex in its own TUI (you watch it in a second
> terminal), bridged through a local proxy. Kimi and ZCode peers are **headless** — the daemon
> spawns them directly, so a single command starts the whole pairing.

## Architecture

AgentBridge uses a two-process architecture per pairing:

- **`bridge.ts`** — the foreground MCP client loaded by the controller via the AgentBridge plugin.
- **`daemon.ts`** — a persistent local background process that owns the peer connection and
  bridge state. When the controller closes, the foreground MCP process exits while the daemon and
  peer keep running; on restart, the controller reconnects automatically with exponential backoff.

```
┌────────────────────┐   MCP stdio / plugin    ┌────────────────────┐
│ Controller         │ ──────────────────────▶ │ bridge.ts          │
│ (Claude Code/Codex)│ ◀──────────────────────  │ foreground client  │
└────────────────────┘                         └─────────┬──────────┘
                                                          │ control WS (4502/4602/4603/4702/4703)
                                                          ▼
                                                ┌────────────────────┐
                                                │ daemon.ts          │
                                                │ bridge daemon      │
                                                └─────────┬──────────┘
                                                          │ peer adapter
                        ┌─────────────────────────────────┼─────────────────────────────────┐
                        ▼                                  ▼                                  ▼
              ┌──────────────────┐              ┌──────────────────┐              ┌──────────────────┐
              │ Codex app-server │              │ Kimi  (kimi acp) │              │ ZCode app-server │
              │ via :4501 proxy  │              │ headless         │              │ --stdio headless │
              └──────────────────┘              └──────────────────┘              └──────────────────┘
```

### Data flow

| Direction | Path |
|-----------|------|
| **Peer → Controller** | peer adapter captures the peer's message → control WS → `bridge.ts` → MCP channel notification (or `get_messages`) |
| **Controller → Peer** | controller calls the `reply` tool → `bridge.ts` → control WS → `daemon.ts` → injected into the peer's active turn |

### Loop prevention

Every message carries a `source` field identifying its origin agent. The bridge never forwards a
message back to the agent it came from.

### Real-time injection

For Codex and ZCode peers, replies are injected into the running turn in real time (via
`turn`/`steer`), so the controller does not have to poll `get_messages` — collaboration keeps
flowing even when the peer is mid-task.

## Prerequisites

| Dependency | Needed for | Install |
|-----------|-----------|---------|
| [Bun](https://bun.sh) v1.0+ | always (runtime for daemon + plugin server) | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+ | Claude as controller | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | Codex as controller or peer | `npm install -g @openai/codex` |
| Kimi Code CLI (`kimi`) | `kimi` / `codex-kimi` pairings | per Kimi's install docs |
| ZCode CLI (`zcode`) | `zcode` / `codex-zcode` pairings | per ZCode's install docs |

> **Note:** Bun is required — Node.js alone is not sufficient. You only need the CLIs for the
> agents you actually pair. The ZCode agent binary is not on `PATH` by default; it is expected at
> `~/.zcode/server/agents/glm/zcode-agent` (override with `ZCODE_BIN`).

## Quick Start (local install)

This fork is not published to a plugin marketplace or npm, so install it from source. (Installing
the upstream `@raysonmeng/agentbridge` package would give you the original, **not** this
multi-agent fork.)

```bash
# 1. Clone and install dependencies
git clone https://github.com/moonaries90/agent-collaboration.git
cd agent-collaboration
bun install
bun link

# 2. Register the local plugin + generate project config
agentbridge dev     # register local marketplace + install the plugin
agentbridge init    # check dependencies, generate .agentbridge/config.json
```

Then start a pairing:

```bash
# Claude Code  ⇄  Codex   (two terminals)
abg claude                 # terminal 1: Claude Code (controller)
abg codex                  # terminal 2: Codex TUI (peer)

# Claude Code  ⇄  Kimi     (single command — Kimi is headless)
abg kimi                   # add --yolo or --auto to auto-approve Kimi's tool calls

# Claude Code  ⇄  ZCode    (single command — ZCode is headless)
abg zcode                  # defaults to yolo; --mode build|edit|plan for tighter modes

# Codex  ⇄  Kimi  /  Codex  ⇄  ZCode
abg codex-kimi
abg codex-zcode            # ZCode replies inject into Codex in real time (no polling)
```

> **Note:** the controller commands inject
> `--dangerously-load-development-channels plugin:agentbridge@agentbridge` automatically, loading
> the local development channel into the controller. Only enable channels and MCP servers you trust.

After changing source code, re-run `agentbridge dev` to sync the plugin cache, then restart the
controller or run `/reload-plugins` in an active Claude Code session.

## CLI Reference

> All commands work with both `agentbridge` and the short alias `abg`.

| Command | Description |
|---------|-------------|
| `abg init` | Install plugin, check dependencies, generate `.agentbridge/config.json` |
| `abg dev` | (Dev only) Register local marketplace + force-sync plugin to cache |
| `abg claude [args...]` | Start Claude Code as controller, bridged to a Codex peer |
| `abg codex [args...]` | Start the Codex TUI peer connected to the daemon |
| `abg kimi [args...]` | Claude Code controller ⇄ headless Kimi peer (port 4602). `--yolo`/`--auto` set Kimi's ACP permission mode |
| `abg codex-kimi [args...]` | Codex controller ⇄ headless Kimi peer (port 4603) |
| `abg zcode [args...]` | Claude Code controller ⇄ headless ZCode peer (port 4702). `--mode build\|edit\|plan` sets the session mode (default `yolo`) |
| `abg codex-zcode [args...]` | Codex controller ⇄ headless ZCode peer (port 4703) |
| `abg kill` | Force-kill all AgentBridge processes and clean up state |
| `abg --help` / `--version` | Show help / version |

### Owned flags

Some flags are injected automatically and cannot be passed manually:

- Controller commands own `--channels` and `--dangerously-load-development-channels`.
- `abg codex` owns `--remote` and `--enable tui_app_server`.

Passing these manually is a hard error pointing you at the native command instead.

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTBRIDGE_PEER` | `codex` | Active peer adapter (`codex` / `kimi` / `zcode`). Set automatically by the `kimi`/`zcode` commands |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | Control port between `bridge.ts` and `daemon.ts` (per pairing — see table above) |
| `AGENTBRIDGE_STATE_DIR` | platform default | State directory. Per-pairing overrides: `~/.abck` (Kimi), `~/.abcz` (ZCode) |
| `AGENTBRIDGE_MODE` | `push` | Message delivery mode (`push` for channels, `pull` for API-key mode) |
| `AGENTBRIDGE_DAEMON_ENTRY` | resolved | Override the daemon entry point (used by plugin bundles) |
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket port |
| `CODEX_PROXY_PORT` | `4501` | Bridge proxy port for the Codex TUI |
| `KIMI_ACP_ARGS` | — | Permission args forwarded to the `kimi acp` subprocess (`--yolo`/`--auto`) |
| `ZCODE_SESSION_MODE` | `yolo` | ZCode session mode (`yolo`/`build`/`edit`/`plan`) |
| `ZCODE_BIN` | `~/.zcode/server/agents/glm/zcode-agent` | Path to the ZCode agent binary |

### State directory

The daemon stores runtime state (`daemon.pid`, `status.json`, `agentbridge.log`, `killed`
sentinel, `startup.lock`) in a platform-aware directory: `~/Library/Application Support/agentbridge/`
on macOS, `$XDG_STATE_HOME/agentbridge/` on Linux. The Kimi and ZCode pairings use dedicated
state dirs (`~/.abck`, `~/.abcz`) so they never collide with the Codex pairing.

## Current Limitations

- Forwards `agentMessage`-style items only, not intermediate `commandExecution` / `fileChange` events
- One peer connection per pairing; a new controller session replaces the previous one
- Fixed ports mean one instance per pairing per machine

### Codex git restriction

When Codex is involved, it runs sandboxed and **blocks all writes to the `.git` directory** — it
cannot `git commit`, `push`, `pull`, `checkout -b`, or `merge`; attempting these hangs the Codex
session. Let the controller (or you) handle git operations; the sandboxed agent should focus on
code changes and report completed work, leaving the git workflow to the side that can run it.

## Roadmap

- **Near term:** smoother multi-peer experience — less noise, better turn discipline, clearer
  collaboration modes. See [docs/v1-roadmap.md](docs/v1-roadmap.md).
- **Later:** stronger multi-agent foundations — room-scoped collaboration, stable identity, a
  formal control protocol, better recovery. See [docs/v2-architecture.md](docs/v2-architecture.md).

> These roadmap docs are inherited from upstream and describe the original direction; treat them
> as background rather than a committed plan for this fork.

## Acknowledgements

AgentBridge was created and open-sourced by **[Rayson (@raysonmeng)](https://github.com/raysonmeng)**
under the MIT license — including the original Claude⇄Codex bridge, the two-process daemon design,
and the plugin/CLI scaffolding this fork builds on. This `agent-collaboration` repository simply
would not exist without it. Enormous thanks to the original author for designing AgentBridge and
sharing it with the community.

If you want the original, upstream project — also installable via its plugin marketplace — please
star and follow it there:

- **Original repository:** https://github.com/raysonmeng/agent-bridge
- **Original author:** [@raysonmeng on X/Twitter](https://x.com/raysonmeng) · [Xiaohongshu](https://www.xiaohongshu.com/user/profile/62a3709d0000000021028b7e)
