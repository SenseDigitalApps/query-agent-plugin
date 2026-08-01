#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { openAsBlob, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

function usage() {
  return [
    "Usage:",
    "  node scripts/query-send-html-attachment.mjs --account <id> --to <target> --thread-id <id> --file <path> --message <text>",
    "  node scripts/query-send-html-attachment.mjs --account <id> --to <target> --thread-id <id> --file <path> --message-file <path>",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function buildUploadUrl(socketUrl, botId) {
  const uploadUrl = new URL(socketUrl);
  uploadUrl.protocol = uploadUrl.protocol === "ws:" ? "http:" : "https:";
  uploadUrl.search = "";
  uploadUrl.hash = "";
  uploadUrl.pathname = `/api/v4/openclaw-agent/bots/${botId}/attachments/`;
  return uploadUrl;
}

function buildSocketUrl(socketUrl, token) {
  const wsUrl = new URL(socketUrl);
  wsUrl.searchParams.set("token", token);
  return wsUrl;
}

async function uploadAttachment({ account, botId, token, filePath, threadId }) {
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`Attachment file is missing or empty: ${filePath}`);
  }
  const filename = path.basename(filePath);
  const form = new FormData();
  form.append("file", await openAsBlob(filePath), filename);
  form.append("kind", "file");
  form.append("mime_type", "text/html");
  form.append("thread_id", String(threadId));

  const response = await fetch(buildUploadUrl(account.url, botId), {
    method: "POST",
    headers: { "X-Agent-Token": token },
    body: form,
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      detail = await response.text();
    }
    throw new Error(`Query upload failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const uploaded = await response.json();
  if (!uploaded?.url) throw new Error("Query upload response did not include a URL.");
  return {
    id: uploaded.id,
    kind: uploaded.kind || "file",
    name: uploaded.name || filename,
    mime_type: uploaded.mime_type || "text/html",
    size: uploaded.size ?? stats.size,
    url: uploaded.url,
  };
}

async function sendEvent({ account, token, event }) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(
      buildSocketUrl(account.url, token),
      account.origin ? { origin: account.origin, handshakeTimeout: 15_000 } : { handshakeTimeout: 15_000 },
    );
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // ignore close failures during timeout cleanup
      }
      reject(new Error("Query websocket send timed out."));
    }, 20_000);
    let sent = false;
    socket.on("open", () => {
      socket.send(JSON.stringify(event), (error) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        sent = true;
        setTimeout(() => socket.close(1000, "attachment send complete"), 1_500);
      });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", (code, reason) => {
      clearTimeout(timer);
      if (sent) resolve();
      else reject(new Error(`Query websocket closed before send: ${code} ${reason.toString("utf8")}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountId = args.account;
  const to = args.to;
  const threadId = args["thread-id"];
  const filePath = args.file;
  const message = args.message ?? (args["message-file"] ? readFileSync(args["message-file"], "utf8") : "");
  if (!accountId || !to || !threadId || !filePath || !message.trim()) {
    throw new Error(usage());
  }

  const config = JSON.parse(
    execFileSync("openclaw", ["config", "get", "channels.query", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const account = config.accounts?.[accountId];
  if (!account?.url) throw new Error(`Query account is not configured: ${accountId}`);
  const parsedSocketUrl = new URL(account.url);
  const token = account.token || parsedSocketUrl.searchParams.get("token");
  if (!token) throw new Error(`Query account token is missing: ${accountId}`);
  const botId = parsedSocketUrl.pathname.match(/openclaw-agent\/(\d+)/)?.[1];
  if (!botId) throw new Error(`Could not resolve Query bot id for account: ${accountId}`);

  const attachment = await uploadAttachment({ account, botId, token, filePath, threadId });
  const clientMsgId = `openclaw-html-attachment-${Date.now()}`;
  await sendEvent({
    account,
    token,
    event: {
      type: "message",
      role: "assistant",
      content: message,
      client_msg_id: clientMsgId,
      thread_id: String(threadId),
      data: {
        source: "openclaw_outbound",
        to,
        thread_id: String(threadId),
        attachments: [attachment],
      },
    },
  });
  console.log(
    JSON.stringify({
      ok: true,
      accountId,
      to,
      threadId: String(threadId),
      clientMsgId,
      attachmentName: attachment.name,
      attachmentSize: attachment.size,
    }),
  );
}

main().catch((error) => fail(error?.stack || String(error)));
