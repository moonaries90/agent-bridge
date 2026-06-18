import { describe, expect, test } from "bun:test";
import { disabledReplyError } from "../bridge-disabled-state";

describe("bridge disabled-state messaging", () => {
  test("kill-disabled sessions explain how to reconnect (default: abg claude)", () => {
    const msg = disabledReplyError("killed", {});
    expect(msg).toContain("disabled by `agentbridge kill`");
    expect(msg).toContain("abg claude");
    // Must NOT hardcode the wrong "restart Claude Code" phrasing or stale /resume hint
    expect(msg).not.toContain("/resume");
  });

  test("kill-disabled error honors AGENTBRIDGE_RESTART_CMD override", () => {
    const msg = disabledReplyError("killed", { AGENTBRIDGE_RESTART_CMD: "abg codex-zcode" });
    expect(msg).toContain("abg codex-zcode");
    expect(msg).not.toContain("abg claude");
  });

  test("kill-disabled error infers restart cmd from AGENTBRIDGE_PEER when no override", () => {
    expect(disabledReplyError("killed", { AGENTBRIDGE_PEER: "kimi" })).toContain("abg kimi");
    expect(disabledReplyError("killed", { AGENTBRIDGE_PEER: "zcode" })).toContain("abg zcode");
  });

  test("rejected sessions explain another controller session is active", () => {
    const message = disabledReplyError("rejected");
    expect(message).toContain("rejected this session");
    expect(message).toContain("another controller session is already connected");
    expect(message).toContain("abg kill");
    expect(message).not.toContain("/resume");
  });
});
