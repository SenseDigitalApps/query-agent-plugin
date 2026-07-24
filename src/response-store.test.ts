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
      threadId: "thread-1",
      clientMsgId: "msg-1",
      type: "message",
      content: "Hola desde El agente",
      data: { attachments: [] },
      completedAt: Date.now(),
    });

    const second = new ResponseStore(filePath);
    await second.load();
    expect(second.get("thread-1", "msg-1")).toMatchObject({
      type: "message",
      content: "Hola desde El agente",
    });
  });

  it("isolates identical client ids across Query threads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-response-store-"));
    temporaryDirectories.push(directory);
    const store = new ResponseStore(join(directory, "responses.json"));
    await store.load();
    await store.set({
      threadId: "private-1",
      clientMsgId: "same-id",
      type: "message",
      content: "Respuesta privada uno",
      data: {},
      completedAt: Date.now(),
    });
    await store.set({
      threadId: "private-2",
      clientMsgId: "same-id",
      type: "message",
      content: "Respuesta privada dos",
      data: {},
      completedAt: Date.now(),
    });

    expect(store.get("private-1", "same-id")?.content).toBe(
      "Respuesta privada uno",
    );
    expect(store.get("private-2", "same-id")?.content).toBe(
      "Respuesta privada dos",
    );
  });

  it("requires an absolute state path", () => {
    expect(() => new ResponseStore("relative/responses.json")).toThrow(/absolute path/);
  });
});
