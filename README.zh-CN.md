# AgentBridge — 多 Agent 协作桥接

English version: [README.md](README.md)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **致敬声明。** 本仓库（`agent-collaboration`）是
> [**AgentBridge**（作者 Rayson / @raysonmeng）](https://github.com/raysonmeng/agent-bridge)
> 的个人深度魔改 fork，怀着对原作者工作的敬意而建。由于改动相对上游已大幅分叉——把原本的
> Claude⇄Codex 桥接扩展成多 Agent 桥接（新增 Kimi、ZCode peer，支持 Codex 作主控，以及回复实时
> 注入）——因此作为独立项目维护，而非以 PR 形式回合上游。原始 MIT 许可证与版权声明完整保留。
> 完整致谢见 [致谢](#致谢)。

在**同一个工作会话**里、在你自己的机器上，让两个编码 Agent 并肩工作、实时对话。你交互式地驱动其中
一个 Agent——**主控（controller）**（Claude Code 或 Codex）——另一个 Agent——**peer**（Codex、
Kimi 或 ZCode）——被桥接进来：peer 的消息被推送给主控，主控的回复被注入回 peer。人始终在环中，
负责分派任务、审查两边产出。

## 这个项目是什么 / 不是什么

**它是：**

- 一个把两个 AI 编码 Agent 连接到同一工作流里的本地开发工具
- 一个在 MCP channel 与各 peer 原生协议之间转发消息的桥接层（Codex app-server、Kimi ACP、
  ZCode app-server）
- 一个面向人工参与、跨厂商 Agent 协作的实验性方案

**它不是：**

- 一个托管服务或多租户系统
- 一个面向任意 Agent 后端的通用编排框架
- 一个可以隔离不可信工具的强化安全边界

## 支持的配对

每个命令把一个主控与一个 peer 配对。各配对使用**独立的端口和状态目录**，因此可以多个同时运行而互不冲突。

| 命令 | 主控 | Peer | Peer 运行方式 | 控制端口 |
|------|------|------|---------------|----------|
| `abg claude` + `abg codex` | Claude Code | Codex | 经本地代理的 Codex TUI | `4502` |
| `abg kimi` | Claude Code | Kimi | 无头（`kimi acp`） | `4602` |
| `abg codex-kimi` | Codex | Kimi | 无头（`kimi acp`） | `4603` |
| `abg zcode` | Claude Code | ZCode | 无头（`zcode app-server --stdio`） | `4702` |
| `abg codex-zcode` | Codex | ZCode | 无头（`zcode app-server --stdio`） | `4703` |

> **无头 vs. TUI。** Codex 配对会单独跑一个 Codex TUI（在第二个终端里观察），通过本地代理桥接。
> Kimi 和 ZCode peer 是**无头**的——由 daemon 直接拉起，所以一条命令就能启动整个配对。

## 架构

每个配对采用两层进程结构：

- **`bridge.ts`** —— 由主控通过 AgentBridge 插件加载的前台 MCP 客户端。
- **`daemon.ts`** —— 常驻本地的后台进程，持有 peer 连接和桥接状态。主控关闭时，前台 MCP 进程退出，
  而 daemon 与 peer 继续存活；主控再次启动时会自动重连（指数退避）。

```
┌────────────────────┐   MCP stdio / plugin    ┌────────────────────┐
│ 主控 Controller     │ ──────────────────────▶ │ bridge.ts          │
│ (Claude Code/Codex)│ ◀──────────────────────  │ 前台 MCP 客户端     │
└────────────────────┘                         └─────────┬──────────┘
                                                          │ 控制 WS (4502/4602/4603/4702/4703)
                                                          ▼
                                                ┌────────────────────┐
                                                │ daemon.ts          │
                                                │ 常驻后台桥接进程    │
                                                └─────────┬──────────┘
                                                          │ peer 适配器
                        ┌─────────────────────────────────┼─────────────────────────────────┐
                        ▼                                  ▼                                  ▼
              ┌──────────────────┐              ┌──────────────────┐              ┌──────────────────┐
              │ Codex app-server │              │ Kimi (kimi acp)  │              │ ZCode app-server │
              │ 经 :4501 代理    │              │ 无头             │              │ --stdio 无头     │
              └──────────────────┘              └──────────────────┘              └──────────────────┘
```

### 数据流

| 方向 | 链路 |
|------|------|
| **Peer → 主控** | peer 适配器捕获 peer 消息 → 控制 WS → `bridge.ts` → MCP channel 通知（或 `get_messages`） |
| **主控 → Peer** | 主控调用 `reply` tool → `bridge.ts` → 控制 WS → `daemon.ts` → 注入到 peer 当前 turn |

### 防循环

每条消息都携带 `source` 字段标识来源 Agent，Bridge 永远不会把消息转发回它的来源。

### 实时注入

对 Codex 与 ZCode peer，回复会通过 `turn`/`steer` 实时注入正在进行的 turn，主控无需轮询
`get_messages`——即使 peer 正在执行任务，协作也能持续流动。

## 前置条件

| 依赖 | 用于 | 安装方式 |
|------|------|----------|
| [Bun](https://bun.sh) v1.0+ | 始终需要（daemon 与插件服务器的运行时） | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+ | Claude 作主控 | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | Codex 作主控或 peer | `npm install -g @openai/codex` |
| Kimi Code CLI（`kimi`） | `kimi` / `codex-kimi` 配对 | 参见 Kimi 安装文档 |
| ZCode CLI（`zcode`） | `zcode` / `codex-zcode` 配对 | 参见 ZCode 安装文档 |

> **注意：** Bun 是必需的，仅有 Node.js 不够。你只需安装实际要配对的 Agent 对应的 CLI。
> ZCode 的 agent 二进制默认不在 `PATH` 上，预期位于
> `~/.zcode/server/agents/glm/zcode-agent`（可用 `ZCODE_BIN` 覆盖）。

## 快速开始（本地安装）

本 fork 未发布到插件市场或 npm，请从源码安装。（安装上游的 `@raysonmeng/agentbridge` 包得到的是
原版，**不是**这个多 Agent fork。）

```bash
# 1. 克隆并安装依赖
git clone https://github.com/moonaries90/agent-collaboration.git
cd agent-collaboration
bun install
bun link

# 2. 注册本地插件 + 生成项目配置
agentbridge dev     # 注册本地 marketplace + 安装插件
agentbridge init    # 检查依赖、生成 .agentbridge/config.json
```

然后启动一个配对：

```bash
# Claude Code  ⇄  Codex   （两个终端）
abg claude                 # 终端 1：Claude Code（主控）
abg codex                  # 终端 2：Codex TUI（peer）

# Claude Code  ⇄  Kimi     （单条命令——Kimi 无头）
abg kimi                   # 加 --yolo 或 --auto 可自动批准 Kimi 的工具调用

# Claude Code  ⇄  ZCode    （单条命令——ZCode 无头）
abg zcode                  # 默认 yolo；--mode build|edit|plan 可用更严格的模式

# Codex  ⇄  Kimi  /  Codex  ⇄  ZCode
abg codex-kimi
abg codex-zcode            # ZCode 回复实时注入 Codex（无需轮询）
```

> **注意：** 主控命令会自动注入
> `--dangerously-load-development-channels plugin:agentbridge@agentbridge`，把本地开发 channel 挂载
> 进主控。请只启用你信任的 channel 和 MCP server。

修改源码后，重新执行 `agentbridge dev` 同步插件缓存，然后重启主控或在活跃的 Claude Code 会话中执行
`/reload-plugins`。

## CLI 命令参考

> 所有命令同时支持 `agentbridge` 和简写别名 `abg`。

| 命令 | 说明 |
|------|------|
| `abg init` | 安装插件、检查依赖、生成 `.agentbridge/config.json` |
| `abg dev` | （开发用）注册本地 marketplace + 强制同步插件到缓存 |
| `abg claude [args...]` | 启动 Claude Code 作主控，桥接 Codex peer |
| `abg codex [args...]` | 启动连接 daemon 的 Codex TUI peer |
| `abg kimi [args...]` | Claude Code 主控 ⇄ 无头 Kimi peer（端口 4602）。`--yolo`/`--auto` 设置 Kimi 的 ACP 权限模式 |
| `abg codex-kimi [args...]` | Codex 主控 ⇄ 无头 Kimi peer（端口 4603） |
| `abg zcode [args...]` | Claude Code 主控 ⇄ 无头 ZCode peer（端口 4702）。`--mode build\|edit\|plan` 设置会话模式（默认 `yolo`） |
| `abg codex-zcode [args...]` | Codex 主控 ⇄ 无头 ZCode peer（端口 4703） |
| `abg kill` | 强制结束所有 AgentBridge 进程并清理状态 |
| `abg --help` / `--version` | 显示帮助 / 版本 |

### Owned flags

部分参数由 CLI 自动注入，不可手动指定：

- 主控命令拥有 `--channels` 和 `--dangerously-load-development-channels`。
- `abg codex` 拥有 `--remote` 和 `--enable tui_app_server`。

手动传入这些参数会报错，并提示改用原生命令。

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENTBRIDGE_PEER` | `codex` | 当前 peer 适配器（`codex` / `kimi` / `zcode`）。由 `kimi`/`zcode` 命令自动设置 |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | `bridge.ts` 与 `daemon.ts` 之间的控制端口（每个配对不同，见上表） |
| `AGENTBRIDGE_STATE_DIR` | 平台默认 | 状态目录。各配对覆盖：`~/.abck`（Kimi）、`~/.abcz`（ZCode） |
| `AGENTBRIDGE_MODE` | `push` | 消息投递模式（`push` 用于 channel，`pull` 用于 API key 模式） |
| `AGENTBRIDGE_DAEMON_ENTRY` | 自动解析 | 覆盖 daemon 入口（插件包使用） |
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket 端口 |
| `CODEX_PROXY_PORT` | `4501` | Codex TUI 连接的 Bridge 代理端口 |
| `KIMI_ACP_ARGS` | — | 转发给 `kimi acp` 子进程的权限参数（`--yolo`/`--auto`） |
| `ZCODE_SESSION_MODE` | `yolo` | ZCode 会话模式（`yolo`/`build`/`edit`/`plan`） |
| `ZCODE_BIN` | `~/.zcode/server/agents/glm/zcode-agent` | ZCode agent 二进制路径 |

### 状态目录

daemon 在平台感知的目录中存储运行时状态（`daemon.pid`、`status.json`、`agentbridge.log`、
`killed` sentinel、`startup.lock`）：macOS 为 `~/Library/Application Support/agentbridge/`，Linux 为
`$XDG_STATE_HOME/agentbridge/`。Kimi 与 ZCode 配对使用独立状态目录（`~/.abck`、`~/.abcz`），与
Codex 配对互不冲突。

## 当前限制

- 只转发 `agentMessage` 类消息，不转发 `commandExecution` / `fileChange` 等中间过程事件
- 每个配对只有一个 peer 连接；新的主控会话会替换旧连接
- 固定端口意味着每台机器每个配对只能运行一个实例

### Codex 的 Git 操作限制

当涉及 Codex 时，它运行在沙箱中，**禁止对 `.git` 目录进行任何写操作**——无法执行 `git commit`、
`push`、`pull`、`checkout -b`、`merge`；尝试这些命令会导致 Codex 会话挂起。请让主控（或你自己）
负责 Git 操作；沙箱中的 Agent 专注于代码修改并汇报完成的工作，Git 工作流交给能执行它的一侧。

## Roadmap

- **近期：** 更顺滑的多 peer 体验——降噪、控回合、更清晰的协作模式。详见
  [docs/v1-roadmap.md](docs/v1-roadmap.md)。
- **远期：** 更强的多 Agent 基础设施——Room 作用域协作、稳定身份、正式控制协议、更强恢复语义。
  详见 [docs/v2-architecture.md](docs/v2-architecture.md)。

> 这些 roadmap 文档继承自上游，描述的是原项目的方向；请当作背景参考，而非本 fork 的承诺计划。

## 致谢

AgentBridge 由 **[Rayson（@raysonmeng）](https://github.com/raysonmeng)** 创建并以 MIT 许可证开源
——包括最初的 Claude⇄Codex 桥接、两层进程的 daemon 设计，以及本 fork 所依赖的插件/CLI 脚手架。
本 `agent-collaboration` 仓库没有原项目就不会存在。在此向原作者设计并开源 AgentBridge、分享给
社区，致以诚挚的感谢。

如果你想要原始的上游项目（也可通过其插件市场安装），请到这里 star 与关注：

- **原始仓库：** https://github.com/raysonmeng/agent-bridge
- **原作者：** [@raysonmeng（X/Twitter）](https://x.com/raysonmeng) · [小红书](https://www.xiaohongshu.com/user/profile/62a3709d0000000021028b7e)
