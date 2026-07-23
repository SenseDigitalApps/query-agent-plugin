import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { queryAttachmentForMediaSource, queryAttachmentForMediaUrl } from "./media.js";

describe("queryAttachmentForMediaUrl", () => {
  it("marks audio media as a Query voice note by default", () => {
    expect(queryAttachmentForMediaUrl("https://cdn.test/reply.ogg?token=1")).toMatchObject({
      kind: "audio",
      name: "reply.ogg",
      mime_type: "audio/ogg",
      is_voice_note: true,
      voice: true,
      url: "https://cdn.test/reply.ogg?token=1",
    });
  });

  it("keeps forced documents as files", () => {
    expect(
      queryAttachmentForMediaUrl("https://cdn.test/reply.mp3", { forceDocument: true }),
    ).toMatchObject({
      kind: "file",
      name: "reply.mp3",
      mime_type: "audio/mpeg",
    });
  });

  it("classifies images and videos without voice-note fields", () => {
    expect(queryAttachmentForMediaUrl("https://cdn.test/image.jpg")).toMatchObject({
      kind: "image",
      mime_type: "image/jpeg",
    });
    expect(queryAttachmentForMediaUrl("https://cdn.test/clip.mp4")).toMatchObject({
      kind: "video",
      mime_type: "video/mp4",
    });
  });

  it("inlines local outbound audio paths instead of exposing server paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".openclaw-media-outbound-test-"));
    const mediaPath = join(directory, ".openclaw", "media", "outbound", "voice.mp3");
    await mkdir(join(directory, ".openclaw", "media", "outbound"), { recursive: true });
    await writeFile(mediaPath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));

    const attachment = await queryAttachmentForMediaSource(mediaPath);

    expect(attachment).toMatchObject({
      kind: "audio",
      name: "voice.mp3",
      mime_type: "audio/mpeg",
      is_voice_note: true,
      voice: true,
    });
    expect(attachment.url).toMatch(/^data:audio\/mpeg;base64,/);
    expect(attachment.url).not.toContain("/.openclaw/media/outbound/");
  });
});
