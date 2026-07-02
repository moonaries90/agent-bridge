import { describe, expect, test } from "bun:test";
import {
  buildBridgeContractReminder,
  buildReplyRequiredInstruction,
  StatusBuffer,
  classifyMessage,
  formatPullMessages,
  parseMarker,
} from "../message-filter";
import type { BridgeMessage } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Default (Claude controller / Codex peer) reminder, for content assertions.
const BRIDGE_CONTRACT_REMINDER = buildBridgeContractReminder();

function makeMsg(content: string, ts?: number): BridgeMessage {
  return { id: `test_${Date.now()}`, source: "codex", content, timestamp: ts ?? Date.now() };
}

describe("parseMarker", () => {
  test("extracts [IMPORTANT] marker", () => {
    const r = parseMarker("[IMPORTANT] task done");
    expect(r.marker).toBe("important");
    expect(r.body).toBe("task done");
  });

  test("extracts [STATUS] marker case-insensitive", () => {
    const r = parseMarker("[status] progress update");
    expect(r.marker).toBe("status");
    expect(r.body).toBe("progress update");
  });

  test("extracts [FYI] marker", () => {
    const r = parseMarker("[FYI] background info");
    expect(r.marker).toBe("fyi");
    expect(r.body).toBe("background info");
  });

  test("returns untagged for no marker", () => {
    const r = parseMarker("plain message");
    expect(r.marker).toBe("untagged");
    expect(r.body).toBe("plain message");
  });

  test("does not treat marker-like words as markers", () => {
    const r = parseMarker("[IMPORTANTLY] not a marker");
    expect(r.marker).toBe("untagged");
    expect(r.body).toBe("[IMPORTANTLY] not a marker");
  });

  test("handles leading whitespace before marker", () => {
    const r = parseMarker("  [STATUS] progress");
    expect(r.marker).toBe("status");
    expect(r.body).toBe("progress");
  });

  test("handles leading newline before marker", () => {
    const r = parseMarker("\n[IMPORTANT] urgent");
    expect(r.marker).toBe("important");
    expect(r.body).toBe("urgent");
  });
});

describe("classifyMessage", () => {
  test("forwards IMPORTANT in filtered mode", () => {
    expect(classifyMessage("[IMPORTANT] x", "filtered")).toEqual({ action: "forward", marker: "important" });
  });

  test("buffers STATUS in filtered mode", () => {
    expect(classifyMessage("[STATUS] x", "filtered")).toEqual({ action: "buffer", marker: "status" });
  });

  test("drops FYI in filtered mode", () => {
    expect(classifyMessage("[FYI] x", "filtered")).toEqual({ action: "drop", marker: "fyi" });
  });

  test("forwards untagged in filtered mode", () => {
    expect(classifyMessage("hello", "filtered")).toEqual({ action: "forward", marker: "untagged" });
  });

  test("forwards everything in full mode", () => {
    expect(classifyMessage("[FYI] x", "full")).toEqual({ action: "forward", marker: "untagged" });
    expect(classifyMessage("[STATUS] x", "full")).toEqual({ action: "forward", marker: "untagged" });
  });
});

describe("formatPullMessages", () => {
  test("returns only IMPORTANT and STATUS messages in marker mode", () => {
    const text = formatPullMessages({
      peerName: "ZCode",
      sessionId: "codex_1",
      messages: [
        makeMsg("plain verbose output", 1705312200000),
        makeMsg("[FYI] background detail", 1705312201000),
        makeMsg("[STATUS] still running", 1705312202000),
        makeMsg("[IMPORTANT] ready", 1705312203000),
      ],
      mode: "markers",
    });

    expect(text).toContain("[4 new messages from ZCode]");
    expect(text).toContain("get_messages filter: returning only [IMPORTANT]/[STATUS] messages");
    expect(text).toContain("suppressed: 2 unmarked/[FYI] messages");
    expect(text).toContain("[STATUS] still running");
    expect(text).toContain("[IMPORTANT] ready");
    expect(text).not.toContain("plain verbose output");
    expect(text).not.toContain("background detail");
  });

  test("treats STATUS summary headers as STATUS messages", () => {
    const text = formatPullMessages({
      peerName: "ZCode",
      sessionId: "codex_1",
      messages: [
        makeMsg("[STATUS summary - 2 update(s), flushed: turn completed]\none\ntwo", 1705312200000),
      ],
      mode: "markers",
    });

    expect(text).toContain("[STATUS summary - 2 update(s)");
    expect(text).toContain("one");
    expect(text).toContain("two");
  });

  test("full mode returns unmarked messages for debugging", () => {
    const text = formatPullMessages({
      peerName: "ZCode",
      sessionId: "codex_1",
      messages: [makeMsg("plain verbose output", 1705312200000)],
      mode: "full",
    });

    expect(text).toContain("plain verbose output");
    expect(text).not.toContain("get_messages filter");
  });

  test("truncates oversized messages by preserving beginning and end", () => {
    const text = formatPullMessages({
      peerName: "ZCode",
      sessionId: "codex_1",
      messages: [makeMsg(`[IMPORTANT] ${"A".repeat(120)} MIDDLE ${"Z".repeat(120)}`, 1705312200000)],
      mode: "markers",
      maxMessageChars: 120,
      maxTotalChars: 1000,
    });

    expect(text).toContain("[IMPORTANT]");
    expect(text).toContain("AAAA");
    expect(text).toContain("ZZZZ");
    expect(text).toContain("truncated");
    expect(text).not.toContain("MIDDLE");
  });

  test("omits additional marker messages past the total output limit", () => {
    const text = formatPullMessages({
      peerName: "ZCode",
      sessionId: "codex_1",
      messages: [
        makeMsg(`[IMPORTANT] ${"a".repeat(200)}`, 1705312200000),
        makeMsg(`[IMPORTANT] ${"b".repeat(200)}`, 1705312201000),
        makeMsg(`[IMPORTANT] ${"c".repeat(200)}`, 1705312202000),
      ],
      mode: "markers",
      maxMessageChars: 200,
      maxTotalChars: 520,
    });

    expect(text).toContain("due to get_messages size limit");
  });
});

describe("StatusBuffer", () => {
  test("flushes when threshold reached", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 2, flushTimeoutMs: 60000 });
    buf.add(makeMsg("[STATUS] a"));
    expect(flushed).toHaveLength(0);
    buf.add(makeMsg("[STATUS] b"));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("2 update(s)");
    buf.dispose();
  });

  test("flushes on timeout", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.add(makeMsg("[STATUS] a"));
    await sleep(40);
    expect(flushed).toHaveLength(1);
    buf.dispose();
  });

  test("manual flush clears buffer", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 60000 });
    buf.add(makeMsg("[STATUS] a"));
    buf.add(makeMsg("[STATUS] b"));
    buf.flush("turn completed");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("flushed: turn completed");
    expect(buf.size).toBe(0);
    buf.dispose();
  });

  test("flush on empty buffer is no-op", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m));
    buf.flush("test");
    expect(flushed).toHaveLength(0);
    buf.dispose();
  });

  test("dispose clears timer and buffer", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.add(makeMsg("[STATUS] a"));
    buf.dispose();
    await sleep(40);
    expect(flushed).toHaveLength(0);
  });
});

describe("StatusBuffer pause/resume", () => {
  test("pause suppresses threshold flush", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 2, flushTimeoutMs: 60000 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    buf.add(makeMsg("[STATUS] b"));
    buf.add(makeMsg("[STATUS] c"));
    expect(flushed).toHaveLength(0);
    expect(buf.size).toBe(3);
    buf.dispose();
  });

  test("pause suppresses timeout flush", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    await sleep(40);
    expect(flushed).toHaveLength(0);
    buf.dispose();
  });

  test("manual flush still works while paused", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 60000 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    buf.flush("important message arrived");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("flushed: important message arrived");
    buf.dispose();
  });

  test("resume triggers threshold flush if buffer is full", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 2, flushTimeoutMs: 60000 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    buf.add(makeMsg("[STATUS] b"));
    buf.add(makeMsg("[STATUS] c"));
    expect(flushed).toHaveLength(0);
    buf.resume();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("3 update(s)");
    buf.dispose();
  });

  test("resume restarts timeout timer", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.pause();
    buf.add(makeMsg("[STATUS] a"));
    await sleep(40);
    expect(flushed).toHaveLength(0); // still paused
    buf.resume();
    await sleep(30);
    expect(flushed).toHaveLength(1); // timer restarted on resume
    buf.dispose();
  });
});

describe("BRIDGE_CONTRACT_REMINDER", () => {
  test("contains marker instructions", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[IMPORTANT]");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[STATUS]");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[FYI]");
  });

  test("defaults reproduce Claude-controller / Codex-peer wording", () => {
    const r = buildBridgeContractReminder();
    expect(r).toContain("delegated to Claude");
    expect(r).toContain("[Role Guidance for Codex]");
    expect(r).toContain("Do not blindly follow Claude");
  });

  test("parameterizes controller + peer names (codex-zcode case)", () => {
    const r = buildBridgeContractReminder("Codex", "ZCode");
    expect(r).toContain("delegated to Codex");
    expect(r).toContain("[Role Guidance for ZCode]");
    expect(r).toContain("Do not blindly follow Codex");
    expect(r).not.toContain("Claude");
    expect(r).not.toContain("Role Guidance for Codex]");
  });

  test("buildReplyRequiredInstruction names the controller", () => {
    expect(buildReplyRequiredInstruction("Codex")).toContain("Codex has explicitly requested");
    expect(buildReplyRequiredInstruction()).toContain("Claude has explicitly requested");
  });
});
