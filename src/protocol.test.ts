import { describe, expect, it } from "vitest";
import { buildSocketUrl, parseQueryEvent, reconnectDelay } from "./protocol.js";

describe("Query protocol", () => {
  it("parses correlated user messages", () => {
    expect(
      parseQueryEvent(
        JSON.stringify({
          type: "message",
          role: "user",
          content: "hola",
          client_msg_id: "msg-1",
          data: { attachments: [] },
        }),
      ),
    ).toMatchObject({ type: "message", content: "hola", client_msg_id: "msg-1" });
  });

  it("rejects malformed and unsupported messages", () => {
    expect(parseQueryEvent("not-json")).toBeNull();
    expect(parseQueryEvent('{"type":"message","role":"assistant"}')).toBeNull();
  });

  it("adds the token without losing existing query parameters", () => {
    const url = new URL(buildSocketUrl("wss://query.test/ws/bot/?tenant=acme", "secret value"));
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("token")).toBe("secret value");
  });

  it("rejects non-WebSocket URLs", () => {
    expect(() => buildSocketUrl("https://query.test/ws/bot/", "secret")).toThrow(/ws:\/\//);
  });

  it("uses bounded exponential reconnect jitter", () => {
    expect(reconnectDelay(0, 500, 15_000, () => 0)).toBe(500);
    expect(reconnectDelay(3, 500, 15_000, () => 1)).toBe(4_000);
    expect(reconnectDelay(20, 500, 15_000, () => 1)).toBe(15_000);
  });
});
