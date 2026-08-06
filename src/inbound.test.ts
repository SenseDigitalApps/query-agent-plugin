import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bodyForAgent,
  materializeInboundMediaAttachments,
  rawBodyForAgent,
} from "./inbound.js";
import type { QueryResolvedAction, QueryUserMessageEvent } from "./types.js";

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

      const materialized = await materializeInboundMediaAttachments(event, { mediaDir });
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

describe("Query inbound resolved actions", () => {
  const messageWith = (resolved: QueryResolvedAction): QueryUserMessageEvent => ({
    type: "message",
    role: "user",
    content: "confirmo",
    client_msg_id: "turn-1",
    data: { thread_name: "General", resolved_action: resolved },
  });

  it("tells the agent the proposal is already applied so it stops asking for a button", () => {
    const body = bodyForAgent(
      messageWith({
        status: "applied",
        decision: "confirm",
        action_id: "a1",
        module_label: "Incidencias",
        record_id: 42,
      }),
    );

    expect(body).toContain("Query ya aplico tu propuesta en Incidencias (registro 42)");
    expect(body).toContain("Da el cambio por hecho");
  });

  it("reports a discarded proposal as such", () => {
    const body = bodyForAgent(
      messageWith({ status: "applied", decision: "cancel", module_label: "Incidencias" }),
    );

    expect(body).toContain("Query descarto tu propuesta en Incidencias");
  });

  it("asks which one when several proposals are waiting", () => {
    const body = bodyForAgent(
      messageWith({
        status: "ambiguous",
        decision: "confirm",
        pending: [
          { action_id: "a1", module_label: "Incidencias" },
          { action_id: "a2", module_label: "Tareas" },
        ],
      }),
    );

    expect(body).toContain("hay 2 esperando y no se sabe cual");
  });

  it("says the proposal is still pending when the person cannot apply it", () => {
    const body = bodyForAgent(
      messageWith({
        status: "not_allowed",
        decision: "confirm",
        module_label: "Incidencias",
      }),
    );

    expect(body).toContain("no tiene permiso para aplicarla");
    expect(body).toContain("sigue pendiente");
  });

  it("says nothing about proposals when Query resolved none", () => {
    const body = bodyForAgent({
      type: "message",
      role: "user",
      content: "hola",
      client_msg_id: "turn-2",
      data: { thread_name: "General" },
    });

    expect(body).not.toContain("propuesta");
  });

  it("materializes inbound images so OpenClaw can attach them", async () => {
    // OpenClaw descarta toda imagen sin ruta local (`resolveAgentTurnAttachments`
    // hace `if (!attachment.path) return false`), asi que una URL sola llegaba
    // al modelo como `imagesCount: 0`.
    const imageBytes = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
      "hex",
    );
    const server = createServer((request, response) => {
      if (!request.url?.startsWith("/captura.png")) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end(imageBytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const mediaDir = await mkdtemp(join(tmpdir(), "query-inbound-image-"));
    try {
      const mediaUrl = `http://127.0.0.1:${address.port}/captura.png`;
      const event: QueryUserMessageEvent = {
        type: "message",
        role: "user",
        content: "mira este screenshot",
        client_msg_id: "screenshot-1",
        data: {
          attachments: [
            {
              id: 42,
              kind: "image",
              name: "captura.png",
              mime_type: "image/png",
              url: mediaUrl,
            },
          ],
        },
      };

      const materialized = await materializeInboundMediaAttachments(event, { mediaDir });
      const attachment = materialized.data?.attachments?.[0];
      expect(attachment?.local_path).toBeTruthy();
      expect(await readFile(attachment?.local_path ?? "")).toEqual(imageBytes);
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("leaves documents alone: only audio and images se bajan a disco", async () => {
    const event: QueryUserMessageEvent = {
      type: "message",
      role: "user",
      content: "te paso el contrato",
      client_msg_id: "doc-1",
      data: {
        attachments: [
          {
            id: 7,
            kind: "file",
            name: "contrato.pdf",
            mime_type: "application/pdf",
            url: "http://127.0.0.1:1/contrato.pdf",
          },
        ],
      },
    };

    const materialized = await materializeInboundMediaAttachments(event, {
      mediaDir: "/tmp/no-deberia-usarse",
    });
    expect(materialized.data?.attachments?.[0]?.local_path).toBeUndefined();
  });

});
