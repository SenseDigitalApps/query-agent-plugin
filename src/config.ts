import {
  DEFAULT_ACCOUNT_ID,
  type QueryAccountConfig,
  type QueryChannelConfig,
  type QueryConfig,
  type ResolvedQueryAccount,
} from "./types.js";

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
  const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const accountSection = resolveQueryAccountSection(section, resolvedAccountId);
  const url = accountSection?.url?.trim() ?? "";
  let urlToken = "";
  try {
    urlToken = new URL(url).searchParams.get("token")?.trim() ?? "";
  } catch {
    // URL validation happens when the transport starts; account inspection stays side-effect free.
  }
  const token =
    accountSection?.token?.trim() || process.env.QUERY_OPENCLAW_TOKEN?.trim() || urlToken;
  const reconnectMinMs = integerInRange(
    accountSection?.reconnectMinMs,
    DEFAULT_RECONNECT_MIN_MS,
    100,
    60_000,
  );
  const reconnectMaxMs = Math.max(
    reconnectMinMs,
    integerInRange(accountSection?.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS, 1_000, 300_000),
  );

  return {
    accountId: resolvedAccountId,
    enabled: accountSection?.enabled !== false,
    configured: Boolean(url && token),
    url,
    token,
    heartbeatMs: integerInRange(accountSection?.heartbeatMs, DEFAULT_HEARTBEAT_MS, 5_000, 55_000),
    origin: accountSection?.origin?.trim() || undefined,
    reconnectMinMs,
    reconnectMaxMs,
    responseTimeoutMs: integerInRange(accountSection?.responseTimeoutMs, 0, 0, 3_600_000),
    stateFile: accountSection?.stateFile?.trim() || undefined,
  };
}

export function listQueryAccountIds(cfg: QueryConfig): string[] {
  const section = cfg.channels?.query;
  const accounts = section?.accounts;
  if (accounts && typeof accounts === "object") {
    const ids = Object.entries(accounts)
      .filter(([, account]) => account && typeof account === "object")
      .map(([id]) => id.trim())
      .filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }
  return [DEFAULT_ACCOUNT_ID];
}

function resolveQueryAccountSection(
  section: QueryChannelConfig | undefined,
  accountId: string,
): QueryAccountConfig | undefined {
  const accounts = section?.accounts;
  const account = accounts && typeof accounts === "object" ? accounts[accountId] : undefined;
  if (account && typeof account === "object") {
    return {
      enabled: section?.enabled,
      heartbeatMs: section?.heartbeatMs,
      origin: section?.origin,
      reconnectMinMs: section?.reconnectMinMs,
      reconnectMaxMs: section?.reconnectMaxMs,
      responseTimeoutMs: section?.responseTimeoutMs,
      stateFile: section?.stateFile,
      ...account,
    };
  }
  return section;
}

export function inspectQueryAccount(account: ResolvedQueryAccount) {
  return {
    enabled: account.enabled,
    configured: account.configured,
    tokenStatus: account.token ? ("available" as const) : ("missing" as const),
  };
}
