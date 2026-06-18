import type { BridgeMessage } from "./types";

export interface DaemonStatus {
  bridgeReady: boolean;
  tuiConnected: boolean;
  /** Whether a controller (CLI or App) is currently attached. Used by the
   * recovery poller to avoid ping-pong when two controllers share one daemon. */
  controllerConnected: boolean;
  threadId: string | null;
  queuedMessageCount: number;
  proxyUrl: string;
  appServerUrl: string;
  /** Proxy URL of the controller-side Codex middleman (codex-zcode / codex-kimi
   * modes only). The controller's Codex TUI connects here via `--remote` so the
   * daemon can inject peer replies as real turns. Undefined when the controller
   * is Claude (no middleman). */
  controllerProxyUrl?: string;
  pid: number;
}

export type ControlClientMessage =
  | { type: "claude_connect" }
  | { type: "claude_disconnect" }
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage; requireReply?: boolean }
  | { type: "status" };

export type ControlServerMessage =
  | { type: "codex_to_claude"; message: BridgeMessage }
  | { type: "claude_to_codex_result"; requestId: string; success: boolean; error?: string }
  | { type: "status"; status: DaemonStatus };

/** WebSocket close code sent by the daemon when a newer Claude session replaces the current one. */
export const CLOSE_CODE_REPLACED = 4001;
