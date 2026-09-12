/**
 * Structural SDK contracts used by Query across supported OpenClaw releases.
 *
 * OpenClaw 2026.9.4 stopped re-exporting several hook-only types from
 * `plugin-sdk/plugin-runtime`.  Keeping the narrow shapes that Query actually
 * consumes here avoids importing private hashed bundles and remains compatible
 * with the public runtime objects supplied by both 2026.7.1-2 and 2026.9.4.
 */

export type QueryBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

export type QueryToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName?: string;
  toolCallId?: string;
  channelId?: string;
};

export type QueryBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

export type QueryCronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: string;
  lastDeliveryError?: string;
};

export type QueryGatewayCronJob = {
  id: string;
  agentId?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: Record<string, unknown> & { kind?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind?: string; text?: string };
  state?: QueryCronJobState;
  createdAtMs?: number;
  updatedAtMs?: number;
};

export type QueryCronChangedEvent = {
  action: "added" | "updated" | "removed" | "started" | "finished" | "scheduled";
  jobId: string;
  job?: QueryGatewayCronJob;
  sessionTarget?: string;
  agentId?: string;
  runAtMs?: number;
  durationMs?: number;
  status?: "ok" | "error" | "skipped";
  completionStatus?: "succeeded" | "failed" | "unknown";
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  deliveryError?: string;
  deliverySuppressionReason?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
};

export type QueryGatewayCronService = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<QueryGatewayCronJob[]>;
  add: (input: Record<string, unknown>) => Promise<unknown>;
  update: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
  removeStaleJobFamily?: (family: {
    declarationKey: string;
    name: string;
    ownerPluginTag: string;
  }) => Promise<number>;
};
