import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { QueryAttachment } from "./types.js";

const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "webm"]);
const IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "webm"]);
const MAX_INLINE_MEDIA_BYTES = 2 * 1024 * 1024;

function extensionForMediaUrl(mediaUrl: string): string {
  const clean = (mediaUrl.split(/[?#]/, 1)[0] ?? mediaUrl).replace(/\\/g, "/");
  const filename = clean.split("/").pop() ?? "";
  const extension = filename.includes(".") ? filename.split(".").pop() : "";
  return extension?.toLowerCase() ?? "";
}

function filenameForMediaUrl(mediaUrl: string): string {
  const clean = (mediaUrl.split(/[?#]/, 1)[0] ?? mediaUrl).replace(/\\/g, "/");
  return clean.split("/").pop() || "attachment";
}

function mimeTypeForExtension(extension: string): string | undefined {
  switch (extension) {
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "m4a":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    case "oga":
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "m4v":
      return "video/x-m4v";
    case "mov":
      return "video/quicktime";
    case "mp4":
      return "video/mp4";
    default:
      return undefined;
  }
}

export function queryAttachmentForMediaUrl(
  mediaUrl: string,
  options: { audioAsVoice?: boolean; forceDocument?: boolean } = {},
): QueryAttachment {
  const extension = extensionForMediaUrl(mediaUrl);
  const mimeType = mimeTypeForExtension(extension);
  const isAudio = Boolean(mimeType?.startsWith("audio/")) || AUDIO_EXTENSIONS.has(extension);
  const isImage = Boolean(mimeType?.startsWith("image/")) || IMAGE_EXTENSIONS.has(extension);
  const isVideo = Boolean(mimeType?.startsWith("video/")) || VIDEO_EXTENSIONS.has(extension);
  const kind = options.forceDocument
    ? "file"
    : isAudio
      ? "audio"
      : isImage
        ? "image"
        : isVideo
          ? "video"
          : "file";

  return {
    kind,
    name: filenameForMediaUrl(mediaUrl),
    url: mediaUrl,
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(kind === "audio" && options.audioAsVoice !== false
      ? { is_voice_note: true, voice: true }
      : {}),
  };
}

export async function queryAttachmentForMediaSource(
  mediaUrl: string,
  options: { audioAsVoice?: boolean; forceDocument?: boolean } = {},
): Promise<QueryAttachment> {
  const attachment = queryAttachmentForMediaUrl(mediaUrl, options);
  if (!isLocalMediaPath(mediaUrl)) {
    return attachment;
  }
  const fileStat = await stat(mediaUrl);
  if (!fileStat.isFile()) {
    throw new Error(`Query media path is not a file: ${mediaUrl}`);
  }
  if (fileStat.size > MAX_INLINE_MEDIA_BYTES) {
    throw new Error(`Query local media is too large to inline: ${mediaUrl}`);
  }
  const bytes = await readFile(mediaUrl);
  const mimeType = attachment.mime_type ?? "application/octet-stream";
  return {
    ...attachment,
    url: `data:${mimeType};base64,${bytes.toString("base64")}`,
  };
}

function isLocalMediaPath(mediaUrl: string): boolean {
  if (!isAbsolute(mediaUrl)) return false;
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(mediaUrl) &&
    !/^[a-z]:[\\/]/i.test(mediaUrl)
  )
    return false;
  return mediaUrl
    .replace(/\\/g, "/")
    .includes("/.openclaw/media/outbound/");
}
