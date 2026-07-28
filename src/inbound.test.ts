import { describe, expect, it } from "vitest";
import { bodyForAgent, rawBodyForAgent } from "./inbound.js";
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
    expect(bodyForAgent(event)).toContain("Nota de voz (nota.ogg) adjunta sin texto");
    expect(bodyForAgent(event)).toContain("Debes usar el audio adjunto como entrada");
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
      "Nota de voz (nota.ogg) transcrita: Revisa el flujo de notas de voz.",
    );
  });
});
