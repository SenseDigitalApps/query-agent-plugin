import WebSocket from "ws";
import { buildSocketUrl } from "./protocol.js";
import type { QueryOutboundEvent, ResolvedQueryAccount } from "./types.js";

export async function sendQueryOutboundEventDirect(
  account: ResolvedQueryAccount,
  event: QueryOutboundEvent,
  options: { closeDelayMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const closeDelayMs = options.closeDelayMs ?? 250;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(
      buildSocketUrl(account.url, account.token),
      account.origin ? { origin: account.origin, handshakeTimeout: 15_000 } : { handshakeTimeout: 15_000 },
    );
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ignore close failures during timeout cleanup.
      }
      reject(new Error("Query direct outbound send timed out."));
    }, timeoutMs);
    timer.unref?.();
    let sent = false;
    let settled = false;

    socket.on("open", () => {
      socket.send(JSON.stringify(event), (error) => {
        if (error) {
          clearTimeout(timer);
          settled = true;
          reject(error);
          return;
        }
        sent = true;
        settled = true;
        clearTimeout(timer);
        resolve();
        setTimeout(() => socket.close(1000, "openclaw outbound send complete"), closeDelayMs).unref?.();
      });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.on("close", (code, reason) => {
      clearTimeout(timer);
      if (sent || settled) return;
      settled = true;
      reject(new Error(`Query direct outbound socket closed before send: ${code} ${reason.toString("utf8")}`));
    });
  });
}
