import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";

export type QueryRunTarget = { sessionKey: string; runId: string };

/** Exact-run cancellation also covers controlled descendants on OpenClaw 2026.9.4. */
export async function abortQueryRun(target: QueryRunTarget): Promise<boolean> {
  if (!target.sessionKey || !target.runId) return false;
  const result = await callGatewayTool<{ ok?: boolean; status?: string; abortedRunId?: string }>(
    "sessions.abort", { timeoutMs: 10_000 }, { key: target.sessionKey, runId: target.runId },
  );
  return result.ok === true && result.status === "aborted" && result.abortedRunId === target.runId;
}

export class QueryTurnStop {
  readonly controller = new AbortController();
  settled = false;
  requestId?: string;
  private target?: QueryRunTarget;
  private rpc?: Promise<boolean>;

  constructor(private readonly abortRun = abortQueryRun) {}

  bind(target: QueryRunTarget) {
    this.target = target;
    // Also covers an admission callback racing with an early Stop.
    if (this.requestId) this.cancel();
  }

  request(requestId: string) {
    this.requestId = requestId;
    this.cancel();
  }

  private cancel() {
    if (this.target) {
      // Let the Gateway capture the exact owner and its descendants before the
      // local signal drains that owner. Never fall back to session-wide abort.
      this.rpc ??= this.abortRun(this.target).catch(() => false).finally(() => {
        this.controller.abort(new Error("query_user_stop"));
      });
    } else {
      this.controller.abort(new Error("query_user_stop"));
    }
  }

  async confirmed(): Promise<boolean> {
    return this.rpc ? await this.rpc : this.controller.signal.aborted;
  }
}
