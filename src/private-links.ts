import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, normalize } from "node:path";
import type { QueryAttachment } from "./types.js";

const PRIVATE_LINK_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,!?;:]+$/;
const MAX_ARTIFACT_SEARCH_DIRS = 8_000;
const ARTIFACT_FILENAME_RE =
  /\.(?:html?|pdf|csv|json|md|txt|xlsx?|docx?|pptx?|zip|png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/i;
const SKIP_SEARCH_DIRS = new Set([
  ".git",
  "node_modules",
  "agent",
  "codex-home",
  "sessions",
  "media",
  "tmp",
  ".tmp",
  "cache",
]);

function configuredRoots(): string[] {
  const raw = process.env.QUERY_PRIVATE_LINK_ROOTS ?? process.env.OPENCLAW_ARTIFACT_ROOTS ?? "";
  const configured = raw
    .split(new RegExp(`[${delimiter},\\n]`))
    .map((value) => value.trim())
    .filter(Boolean);
  const home = homedir();
  return Array.from(
    new Set([
      ...configured,
      process.env.OPENCLAW_WORKSPACE_DIR ?? "",
      process.env.OPENCLAW_WORKSPACE ?? "",
      join(home, ".openclaw", "workspace", "query-marketing"),
      join(home, ".openclaw", "workspace"),
      join(process.cwd(), "query-marketing"),
      process.cwd(),
    ].filter(Boolean)),
  );
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale/CGNAT.
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    const stats = await stat(path);
    if (stats.isFile()) return path;
  } catch {
    // Candidate did not map to a local file.
  }
  return undefined;
}

async function findArtifactByFilename(root: string, filename: string): Promise<string | undefined> {
  if (!ARTIFACT_FILENAME_RE.test(filename)) return undefined;
  const queue = [normalize(root)];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_ARTIFACT_SEARCH_DIRS) {
    const current = queue.shift();
    if (!current) continue;
    visited += 1;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isFile() && entry.name === filename) return path;
      if (!entry.isDirectory() || SKIP_SEARCH_DIRS.has(entry.name)) continue;
      queue.push(path);
    }
  }
  return undefined;
}

function safeJoin(root: string, pathname: string): string | undefined {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!relative || relative.includes("\0")) return undefined;
  const candidate = normalize(join(root, relative));
  const normalizedRoot = normalize(root);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}/`)) return undefined;
  return candidate;
}

export async function localArtifactPathForPrivateUrl(rawUrl: string): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !isPrivateHostname(parsed.hostname)) {
    return undefined;
  }

  const direct = decodeURIComponent(parsed.pathname);
  if (isAbsolute(direct)) {
    const found = await existingFile(direct);
    if (found) return found;
  }
  for (const root of configuredRoots()) {
    const candidate = safeJoin(root, parsed.pathname);
    if (!candidate) continue;
    const found = await existingFile(candidate);
    if (found) return found;
  }
  const filename = basename(decodeURIComponent(parsed.pathname));
  if (filename && ARTIFACT_FILENAME_RE.test(filename)) {
    for (const root of configuredRoots()) {
      const found = await findArtifactByFilename(root, filename);
      if (found) return found;
    }
  }
  return undefined;
}

export async function rewritePrivateArtifactLinks(params: {
  text: string;
  upload: (path: string, sourceUrl: string) => Promise<QueryAttachment>;
  onBlocked?: (sourceUrl: string) => void;
}): Promise<{ text: string; attachments: QueryAttachment[]; blockedUrls: string[] }> {
  const matches = Array.from(params.text.matchAll(PRIVATE_LINK_RE));
  if (matches.length === 0) return { text: params.text, attachments: [], blockedUrls: [] };

  let rewritten = params.text;
  const replacements = new Map<string, string>();
  const attachments: QueryAttachment[] = [];
  const blockedUrls: string[] = [];

  for (const match of matches) {
    const token = match[0];
    const suffix = token.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? "";
    const sourceUrl = suffix ? token.slice(0, -suffix.length) : token;
    if (!sourceUrl || replacements.has(token)) continue;
    const path = await localArtifactPathForPrivateUrl(sourceUrl);
    if (!path) {
      blockedUrls.push(sourceUrl);
      params.onBlocked?.(sourceUrl);
      replacements.set(token, `[archivo privado no entregado]${suffix}`);
      continue;
    }
    try {
      const attachment = await params.upload(path, sourceUrl);
      attachments.push(attachment);
      replacements.set(token, `${attachment.url}${suffix}`);
    } catch {
      blockedUrls.push(sourceUrl);
      params.onBlocked?.(sourceUrl);
      replacements.set(token, `[archivo privado no entregado]${suffix}`);
    }
  }

  for (const [source, replacement] of replacements) {
    rewritten = rewritten.split(source).join(replacement);
  }
  if (blockedUrls.length > 0) {
    rewritten = `${rewritten.trim()}\n\nNo envié ${blockedUrls.length} link(s) privado(s) porque no pude resolverlos a un archivo local para subirlos a Query.`;
  }
  return { text: rewritten, attachments, blockedUrls };
}
