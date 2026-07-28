import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bodyForAgent,
  materializeInboundAudioAttachments,
  rawBodyForAgent,
} from "./inbound.js";
import type { QueryUserMessageEvent } from "./types.js";

describe("Query inbound body", () => {
  it("labels audio-only messages as voice notes instead of generic attachments", () => {
    const event: QueryUserMessageEvent = {
      type: "message",
      role: "user",
      content: "",
      client_msg_id: "voice-1",
      data: {
        attachments: [
          {
            kind: "audio",
            name: "nota.ogg",
            mime_type: "audio/ogg",
            url: "https://example.test/nota.ogg",
          },
        ],
      },
    };

    expect(rawBodyForAgent(event)).toBe("[Nota de voz adjunta]");
    expect(bodyForAgent(event)).toContain("AudioAttachment 1:");
    expect(bodyForAgent(event)).toContain("Filename: nota.ogg");
    expect(bodyForAgent(event)).toContain("MediaType: audio/ogg");
    expect(bodyForAgent(event)).toContain("MediaUrl: https://example.test/nota.ogg");
    expect(bodyForAgent(event)).toContain("usa este audio como entrada directa del usuario");
  });

  it("passes attachment transcripts explicitly when Query provides one", () => {
    const event: QueryUserMessageEvent = {
      type: "message",
      role: "user",
      content: "",
      client_msg_id: "voice-2",
      data: {
        attachments: [
          {
            kind: "audio",
            name: "nota.ogg",
            mime_type: "audio/ogg",
            transcript: "Revisa el flujo de notas de voz.",
            url: "https://example.test/nota.ogg",
          },
        ],
      },
    };

    expect(bodyForAgent(event)).toContain(
      "Transcript: [system-generated] Revisa el flujo de notas de voz.",
    );
  });

  it("materializes a remote .m4a voice note and exposes structured prompt fields", async () => {
    const audioBytes = Buffer.from("fake-m4a-audio");
    const server = createServer((request, response) => {
      if (request.url !== "/voice-note.m4a") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "audio/mp4" });
      response.end(audioBytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const mediaDir = await mkdtemp(join(tmpdir(), "query-inbound-media-"));
    try {
      const mediaUrl = `http://127.0.0.1:${address.port}/voice-note.m4a`;
      const event: QueryUserMessageEvent = {
        type: "message",
        role: "user",
        content: "",
        client_msg_id: "voice-m4a",
        data: {
          attachments: [
            {
              id: "telegram-file-1",
              kind: "audio",
              name: "nota-query.m4a",
              mime_type: "audio/mp4",
              duration_seconds: 7,
              url: mediaUrl,
            },
          ],
        },
      };

      const materialized = await materializeInboundAudioAttachments(event, { mediaDir });
      const attachment = materialized.data?.attachments?.[0];
      expect(attachment?.local_path).toMatch(
        new RegExp(
          `^${mediaDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]voice-m4a-.*nota-query\\.m4a$`,
        ),
      );
      expect(await readFile(attachment?.local_path ?? "")).toEqual(audioBytes);

      const body = bodyForAgent(materialized);
      expect(body).toContain("AudioAttachment 1:");
      expect(body).toContain(`LocalMediaPath: ${attachment?.local_path}`);
      expect(body).toContain("MediaType: audio/mp4");
      expect(body).toContain(`MediaPath: ${mediaUrl}`);
      expect(body).toContain(`MediaUrl: ${mediaUrl}`);
      expect(body).toContain("Filename: nota-query.m4a");
      expect(body).toContain("Duration: 7s");
      expect(body).toContain("Instruction: usa este audio como entrada directa del usuario");
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
