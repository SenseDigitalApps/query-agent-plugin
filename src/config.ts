import { DEFAULT_ACCOUNT_ID, type QueryConfig, type ResolvedQueryAccount } from "./types.js";

const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_RECONNECT_MIN_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 15_000;

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function resolveQueryAccount(
  cfg: QueryConfig,
  accountId?: string | null,
): ResolvedQueryAccount {
  const section = cfg.channels?.query;
  const url = section?.url?.trim() ?? "";
  let urlToken = "";
  try {
    urlToken = new URL(url).searchParams.get("token")?.trim() ?? "";
  } catch {
    // URL validation happens when the transport starts; account inspection stays side-effect free.
  }
  const token =
    section?.token?.trim() || process.env.QUERY_OPENCLAW_TOKEN?.trim() || urlToken;
  const reconnectMinMs = integerInRange(
    section?.reconnectMinMs,
    DEFAULT_RECONNECT_MIN_MS,
    100,
    60_000,
  );
  const reconnectMaxMs = Math.max(
    reconnectMinMs,
    integerInRange(section?.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS, 1_000, 300_000),
  );

  return {
    accountId: accountId?.trim() || DEFAULT_ACCOUNT_ID,
    enabled: section?.enabled !== false,
    configured: Boolean(url && token),
    url,
    token,
    heartbeatMs: integerInRange(section?.heartbeatMs, DEFAULT_HEARTBEAT_MS, 5_000, 55_000),
    origin: section?.origin?.trim() || undefined,
    reconnectMinMs,
    reconnectMaxMs,
    responseTimeoutMs: integerInRange(section?.responseTimeoutMs, 0, 0, 3_600_000),
    stateFile: section?.stateFile?.trim() || undefined,
  };
}

export function inspectQueryAccount(account: ResolvedQueryAccount) {
  return {
    enabled: account.enabled,
    configured: account.configured,
    tokenStatus: account.token ? ("available" as const) : ("missing" as const),
  };
}
