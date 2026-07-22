import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseStore } from "./response-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ResponseStore", () => {
  it("persists terminal responses across process restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-response-store-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "responses.json");
    const first = new ResponseStore(filePath);
    await first.load();
    await first.set({
      clientMsgId: "msg-1",
      type: "message",
      content: "Hola desde OpenClaw",
      data: { attachments: [] },
      completedAt: Date.now(),
    });

    const second = new ResponseStore(filePath);
    await second.load();
    expect(second.get("msg-1")).toMatchObject({
      type: "message",
      content: "Hola desde OpenClaw",
    });
  });

  it("requires an absolute state path", () => {
    expect(() => new ResponseStore("relative/responses.json")).toThrow(/absolute path/);
  });
});
