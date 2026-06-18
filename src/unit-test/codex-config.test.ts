import { describe, expect, test } from "bun:test";
import {
  upsertAgentBridgeMcp,
  removeAgentBridgeMcp,
  type AgentBridgeMcpConfig,
} from "../codex-config";

const sampleConfig: AgentBridgeMcpConfig = {
  bridgeScript: "/path/to/codex-bridge-mcp.ts",
  peer: "zcode",
  controlPort: 4703,
  stateDir: "/Users/test/.abcz-codex",
  daemonEntry: "/path/to/daemon.ts",
  restartCmd: "abg codex-zcode",
};

describe("codex-config upsertAgentBridgeMcp", () => {
  test("inserts into config with existing [mcp_servers] header", () => {
    const content = `[mcp_servers]\n\n[mcp_servers.node_repl]\ncommand = "echo"\n`;
    const result = upsertAgentBridgeMcp(content, sampleConfig);
    expect(result).toContain("# AgentBridge:start");
    expect(result).toContain("# AgentBridge:end");
    expect(result).toContain('[mcp_servers.agentbridge]');
    expect(result).toContain('command = "bun"');
    expect(result).toContain('AGENTBRIDGE_PEER = "zcode"');
    expect(result).toContain('AGENTBRIDGE_CONTROL_PORT = "4703"');
    // Original content preserved
    expect(result).toContain("[mcp_servers.node_repl]");
  });

  test("appends [mcp_servers] header when absent", () => {
    const content = `model = "gpt-5.5"\n`;
    const result = upsertAgentBridgeMcp(content, sampleConfig);
    expect(result).toContain("[mcp_servers]");
    expect(result).toContain("# AgentBridge:start");
    expect(result).toContain('AGENTBRIDGE_PEER = "zcode"');
    // Original content preserved
    expect(result).toContain('model = "gpt-5.5"');
  });

  test("creates content from empty string", () => {
    const result = upsertAgentBridgeMcp("", sampleConfig);
    expect(result).toContain("[mcp_servers]");
    expect(result).toContain("# AgentBridge:start");
    expect(result).toContain("# AgentBridge:end");
  });

  test("updates existing marked section (idempotent re-run)", () => {
    const content = upsertAgentBridgeMcp("", sampleConfig);
    // Re-run with different peer
    const updated = upsertAgentBridgeMcp(content, { ...sampleConfig, peer: "kimi", controlPort: 4603 });
    // Should have exactly ONE start and ONE end marker
    expect(updated.match(/# AgentBridge:start/g)).toHaveLength(1);
    expect(updated.match(/# AgentBridge:end/g)).toHaveLength(1);
    // Updated values
    expect(updated).toContain('AGENTBRIDGE_PEER = "kimi"');
    expect(updated).toContain('AGENTBRIDGE_CONTROL_PORT = "4603"');
    // Old values gone
    expect(updated).not.toContain('AGENTBRIDGE_PEER = "zcode"');
  });

  test("throws on malformed markers (start without end)", () => {
    const content = `# AgentBridge:start\n[mcp_servers.agentbridge]\ncommand = "old"\n`;
    expect(() => upsertAgentBridgeMcp(content, sampleConfig)).toThrow(/Malformed/);
  });
});

describe("codex-config removeAgentBridgeMcp", () => {
  test("removes the marked section cleanly", () => {
    const content = upsertAgentBridgeMcp("[mcp_servers]\n", sampleConfig);
    const removed = removeAgentBridgeMcp(content);
    expect(removed).not.toContain("# AgentBridge:start");
    expect(removed).not.toContain("# AgentBridge:end");
    expect(removed).not.toContain("[mcp_servers.agentbridge]");
    // Header preserved
    expect(removed).toContain("[mcp_servers]");
  });

  test("returns unchanged content when no markers exist", () => {
    const content = `model = "gpt-5.5"\n[mcp_servers]\n`;
    const result = removeAgentBridgeMcp(content);
    expect(result).toBe(content);
  });

  test("remove then re-add preserves structure", () => {
    const original = "[mcp_servers]\n\n[mcp_servers.pencil]\ncommand = \"x\"\n";
    const added = upsertAgentBridgeMcp(original, sampleConfig);
    const removed = removeAgentBridgeMcp(added);
    const reAdded = upsertAgentBridgeMcp(removed, sampleConfig);
    // Re-added should contain exactly one marker pair and the right config.
    expect(reAdded.match(/# AgentBridge:start/g)).toHaveLength(1);
    expect(reAdded.match(/# AgentBridge:end/g)).toHaveLength(1);
    expect(reAdded).toContain('AGENTBRIDGE_PEER = "zcode"');
    // Original non-agentbridge content preserved through the round trip.
    expect(reAdded).toContain("[mcp_servers.pencil]");
  });
});
