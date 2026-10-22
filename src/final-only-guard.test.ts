import { describe, it, expect } from "vitest";
import { blocksQueryProgress, registerQueryFinalOnlyGuard } from "./final-only-guard.js";
describe("Query final-only message guard", () => {
  it("blocks the explicit progress route seen in Lia", () => {
    expect(blocksQueryProgress("message", { action: "send", channel: "query", accountId: "lia", target: "channel:144", final: false }, true)).toBe(true);
  });
  it("covers implicit source delivery without affecting other channels", () => {
    expect(blocksQueryProgress("message", { action: "send", final: false }, true)).toBe(true);
    expect(blocksQueryProgress("message", { action: "send", final: false }, false)).toBe(false);
    expect(blocksQueryProgress("message", { action: "send", channel: "telegram", final: false }, true)).toBe(false);
  });
  it("preserves final replies, attachments and interactive questions", () => {
    for (const final of [true, undefined]) expect(blocksQueryProgress("message", {action:"send",channel:"query",final},true)).toBe(false);
    expect(blocksQueryProgress("query_question_ask", {final:false},true)).toBe(false);
    expect(blocksQueryProgress("message", {action:"upload-file",channel:"query",final:false},true)).toBe(false);
  });
  it("registers an enforcement hook that does not pretend delivery succeeded", async () => {
    let hook: any;
    registerQueryFinalOnlyGuard({on: (_: string, h: any) => {hook=h;}} as any);
    const result = await hook({toolName:"message",params:{action:"send",channel:"query",final:false}},{});
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("no se envio");
  });
});
