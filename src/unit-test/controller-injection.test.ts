import { describe, expect, test } from "bun:test";
import {
  dedupePeerTurnContent,
  formatControllerInjection,
  buildControllerKickoff,
} from "../controller-injection";

describe("dedupePeerTurnContent", () => {
  test("drops empty and whitespace-only entries", () => {
    expect(dedupePeerTurnContent(["", "  ", "\n", "hello"])).toEqual(["hello"]);
  });

  test("trims entries", () => {
    expect(dedupePeerTurnContent(["  hi  "])).toEqual(["hi"]);
  });

  test("collapses exact duplicates", () => {
    expect(dedupePeerTurnContent(["same", "same"])).toEqual(["same"]);
  });

  test("collapses a substring into its containing entry (keeps the longer)", () => {
    // Order 1: longer first, shorter is dropped.
    expect(dedupePeerTurnContent(["full status text", "status"])).toEqual([
      "full status text",
    ]);
    // Order 2: shorter first, replaced by the longer.
    expect(dedupePeerTurnContent(["status", "full status text"])).toEqual([
      "full status text",
    ]);
  });

  test("keeps distinct entries in order", () => {
    expect(dedupePeerTurnContent(["alpha", "beta", "gamma"])).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  test("real-world: ZCode status emitted as STATUS + near-identical untagged copy collapses to one", () => {
    const statusCopy = "ZCode is connected and ready. Repo on feat/codex-realtime-push.";
    const untaggedCopy =
      "ZCode is connected and ready. Repo on feat/codex-realtime-push."; // identical text, different filter tag upstream
    expect(dedupePeerTurnContent([statusCopy, untaggedCopy])).toEqual([statusCopy]);
  });
});

describe("formatControllerInjection", () => {
  test("returns null when there is nothing to inject", () => {
    expect(formatControllerInjection("ZCode", [])).toBeNull();
    expect(formatControllerInjection("ZCode", ["", "   "])).toBeNull();
  });

  test("prefixes with the peer name so the controller knows the source", () => {
    const out = formatControllerInjection("ZCode", ["done"]);
    expect(out).toBe("[Message from ZCode]\ndone");
  });

  test("joins distinct parts with a blank line", () => {
    const out = formatControllerInjection("Kimi", ["first", "second"]);
    expect(out).toBe("[Message from Kimi]\nfirst\n\nsecond");
  });

  test("coalesces a duplicated peer turn into a single non-redundant injection", () => {
    const out = formatControllerInjection("ZCode", ["hello world", "hello world"]);
    expect(out).toBe("[Message from ZCode]\nhello world");
  });
});

describe("buildControllerKickoff", () => {
  test("names the peer and states real-time delivery (no polling)", () => {
    const k = buildControllerKickoff("ZCode");
    expect(k).toContain("ZCode");
    expect(k).toContain("CONTROLLER");
    expect(k).toContain("no polling");
    expect(k).toContain("[Message from ZCode]");
    expect(k.toLowerCase()).toContain("reply");
    expect(k).toContain("30 minutes");
    expect(k).toContain("busy");
    expect(k).toContain("replay/fallback");
  });
});
