import { describe, expect, it } from "vitest";
import { uploadTargetForOutbound } from "./channel.js";

describe("uploadTargetForOutbound", () => {
  it("uses the concrete thread id when present", () => {
    expect(uploadTargetForOutbound("channel:3", 3)).toBe("3");
    expect(uploadTargetForOutbound("channel:3", "42")).toBe("42");
  });

  it("normalizes OpenClaw channel targets for Query attachment uploads", () => {
    expect(uploadTargetForOutbound("channel:3")).toBe("3");
    expect(uploadTargetForOutbound("user:7")).toBe("user:7");
  });
});
