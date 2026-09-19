import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import { mkdir, readFile, writeFile, readdir, unlink, rmdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { normalizeAgentId, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { writeAgentProfileFiles } from "./agent-profile.js";
import { listQueryAccountIds, resolveQueryAccount } from "./config.js";
import { waitProvisionReady } from "./provision-readiness.js";
import type { QueryConfig } from "./types.js";

const Identifier = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" });
export const ProvisionManifestSchema = Type.Object({
  type: Type.Literal("query_openclaw_provision"), version: Type.Literal(1),
  idempotency_key: Identifier,
  agent: Type.Object({ suggested_id: Identifier, display_name: Type.String({ minLength: 1, maxLength: 200 }),
    workspace_slug: Identifier, personality: Type.String({ maxLength: 100000 }), mission: Type.String({ maxLength: 100000 }),
    effort_mode: Type.Union(["auto", "fast", "normal", "careful", "exhaustive"].map(value => Type.Literal(value))),
  }, { additionalProperties: false }),
  query_account: Type.Object({ suggested_id: Identifier }, { additionalProperties: false }),
  connection: Type.Object({ url: Type.String({ minLength: 1, maxLength: 8192 }), protocol: Type.Literal("query-openclaw.v2") }, { additionalProperties: false }),
  binding: Type.Object({ channel: Type.Literal("query"), account_id: Identifier }, { additionalProperties: false }),
}, { additionalProperties: false });

type Manifest = { type: string; version: number; idempotency_key: string;
  agent: { suggested_id: string; workspace_slug: string; display_name: string; personality: string; mission: string; effort_mode: string };
  query_account: { suggested_id: string }; connection: { url: string; protocol: string };
  binding: { channel: string; account_id: string } };
const fail = (code: string): never => { throw new Error(code); };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = isDeepStrictEqual;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export async function validateProvisionManifest(raw: unknown): Promise<Manifest> {
  if (!object(raw) || raw.type !== "query_openclaw_provision" || raw.version !== 1) fail("manifest_version_unsupported");
  const { Check } = await import("typebox/value");
  if (!Check(ProvisionManifestSchema, raw)) fail("manifest_invalid");
  const manifest = structuredClone(raw) as Manifest;
  manifest.agent.suggested_id = normalizeAgentId(manifest.agent.suggested_id);
  manifest.query_account.suggested_id = normalizeAccountId(manifest.query_account.suggested_id);
  manifest.binding.account_id = normalizeAccountId(manifest.binding.account_id);
  if (manifest.binding.account_id !== manifest.query_account.suggested_id ||
      normalizeAgentId(manifest.agent.workspace_slug) !== manifest.agent.suggested_id) fail("manifest_identity_mismatch");
  let url: URL;
  try { url = new URL(manifest.connection.url); } catch { return fail("connection_url_invalid"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local)) fail("connection_wss_required");
  if (url.username || url.password || url.hash || !url.searchParams.get("token")) fail("connection_url_invalid");
  return manifest;
}

type RuntimeConfig = OpenClawPluginApi["runtime"]["config"];
export type ProvisionDependencies = {
  config: Pick<RuntimeConfig, "current" | "mutateConfigFile">;
  readSource?: () => Promise<OpenClawConfig>;
  workspace?: (cfg: OpenClawConfig, agentId: string) => string;
  waitReady?: typeof waitProvisionReady;
  timeoutMs?: number;
};
const MARKER = ".query-provision.json";
const ACTIVATION = ".query-provision-activation.json";
type ActivationState = { version: 1; agentId: string; accountId: string; fingerprint: string;
  status: "pending_activation" | "ready" | "activation_failed"; expectedAccountIds: string[]; updatedAt: string };
const activationText = (agentId: string, accountId: string, manifestFingerprint: string, status: ActivationState["status"], expectedAccountIds: string[]) =>
  JSON.stringify({ version: 1, agentId, accountId, fingerprint: manifestFingerprint, status, expectedAccountIds, updatedAt: new Date().toISOString() });


// Preserve the host's schema: newer hosts key agents by id; legacy hosts use a list.
type AgentRegistry = {
  entries?: Record<string, Record<string, unknown>>;
  list?: Array<Record<string, unknown> & { id: string }>;
};
const registry = (cfg: OpenClawConfig) => cfg.agents as unknown as AgentRegistry | undefined;
function provisionAgents(cfg: OpenClawConfig): Array<Record<string, unknown> & { id: string }> {
  const agents = registry(cfg);
  if (agents?.entries) return Object.entries(agents.entries).map(([id, entry]) => ({ id, ...entry }));
  return agents?.list ?? [];
}
function storeProvisionAgent(cfg: OpenClawConfig, agent: Record<string, unknown>, remove = false) {
  const agents = registry(cfg);
  if (!agents) return fail("query_provision_host_not_initialized");
  const id = String(agent.id);
  if (agents.entries) {
    if (remove) delete agents.entries[id];
    else {
      const { id: _id, ...entry } = structuredClone(agent);
      agents.entries[id] = entry;
    }
  } else if (agents.list) {
    if (remove) agents.list = agents.list.filter(item => item.id !== id);
    else agents.list.push(structuredClone(agent) as Record<string, unknown> & { id: string });
  } else fail("query_provision_host_not_initialized");
}

export async function provisionQueryAgent(raw: unknown, dryRun: boolean, deps: ProvisionDependencies) {
  let lock: string | undefined;
  let workspace = "";
  let ownsWorkspace = false;
  let committed = false;
  let mutationAttempted = false;
  const ownedFiles = new Map<string, string>();
  let marker = "";
  let agentId = "";
  let accountId = "";
  let originalAccounts: Array<{ id: string; url: string }> = [];
  let newAgent: Record<string, unknown>;
  let newAccount: Record<string, unknown>;
  let newBinding: Record<string, unknown>;
  const ready = deps.waitReady ?? waitProvisionReady;
  const timeout = deps.timeoutMs ?? 60000;
  const cleanup = async () => {
    if (!ownsWorkspace) return;
    // This directory was exclusively created by this transaction. Never
    // recursively remove files written by a user or by an active agent.
    const names = await readdir(workspace);
    if (names.some(name => ![MARKER, ACTIVATION, "SOUL.md", "IDENTITY.md"].includes(name))) fail("workspace_cleanup_conflict");
    for (const name of names) {
      if (!ownedFiles.has(name) || await readFile(join(workspace, name), "utf8") !== ownedFiles.get(name)) fail("workspace_cleanup_conflict");
    }
    for (const name of names) await unlink(join(workspace, name));
    await rmdir(workspace);
    ownsWorkspace = false;
  };
  try {
    const manifest = await validateProvisionManifest(raw);
    agentId = manifest.agent.suggested_id;
    accountId = manifest.query_account.suggested_id;
    // A runtime snapshot may contain defaults/resolved secrets absent from source.
    // Capture source before readiness work; compare only source-to-source under
    // the SDK transaction lock. Never persist the runtime representation.
    const source = structuredClone(await (deps.readSource ?? (async () => {
      const { snapshot } = await readConfigFileSnapshotForWrite();
      if (!snapshot.valid) return fail("source_configuration_invalid");
      return snapshot.sourceConfig;
    }))()) as QueryConfig;
    const cfg = structuredClone(deps.config.current()) as QueryConfig;
    if (!provisionAgents(cfg).length || !Array.isArray(cfg.bindings) || !cfg.channels?.query || cfg.channels.query.enabled === false) fail("query_provision_host_not_initialized");
    workspace = resolve((deps.workspace ?? resolveAgentWorkspaceDir)(cfg, agentId));
    const parent = await realpath(dirname(workspace));
    if (parent !== dirname(workspace)) fail("workspace_parent_symlink");
    const lockPath = join(parent, ".query-provision.lock");
    if (!dryRun) { await mkdir(lockPath).catch(() => fail("query_provision_locked")); lock = lockPath; }
    const markerData = { version: 1, key: manifest.idempotency_key, fingerprint: fingerprint(manifest), agentId, accountId };
    marker = JSON.stringify(markerData);
    newAgent = { id: agentId, name: manifest.agent.display_name, workspace };
    // URL token is explicit for this account. Refuse a conflicting global token
    // rather than silently authenticating a new account with another identity.
    const envToken = process.env.QUERY_OPENCLAW_TOKEN?.trim();
    if (envToken && envToken !== new URL(manifest.connection.url).searchParams.get("token")) fail("global_query_token_conflict");
    newAccount = { enabled: true, url: manifest.connection.url, effortMode: manifest.agent.effort_mode };
    newBinding = { type: "route", agentId, match: { channel: "query", accountId } };
    const inspect = (current: QueryConfig) => {
      const agents = provisionAgents(current);
      const agent = agents.find(item => normalizeAgentId(item.id) === agentId);
      const accounts = current.channels?.query?.accounts ?? {};
      const matchingId = Object.keys(accounts).find(id => normalizeAccountId(id) === accountId);
      const bindings = current.bindings ?? [];
      const bound = bindings.filter(item => item.type === "route" && item.match.channel === "query" && normalizeAccountId(item.match.accountId) === accountId);
      if (agent || matchingId || bound.length) {
        if (equal(agent, newAgent) && matchingId === accountId && equal(accounts[accountId], newAccount) && bound.length === 1 && equal(bound[0], newBinding)) return "present";
        fail("agent_account_or_binding_collision");
      }
      if (agents.some(item => resolveAgentWorkspaceDir(current, item.id) === workspace)) fail("workspace_collision");
      if (listQueryAccountIds(current).some(id => resolveQueryAccount(current, id).url === manifest.connection.url)) fail("connection_already_assigned");
      return "absent";
    };
    const state = inspect(cfg);
    let existingMarker: string | undefined;
    try { existingMarker = await readFile(join(workspace, MARKER), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("workspace_collision"); }
    if (state === "present") {
      if (existingMarker !== marker) fail("manifest_collision");
      const connected = dryRun || await ready([{ id: accountId, url: manifest.connection.url }], timeout);
      return { status: connected ? "already_present" : "failed", agentId, accountId, workspace, connection: dryRun ? "not_checked" : connected ? "ready" : "timeout", dry_run: dryRun };
    }
    try { await readdir(workspace); fail("workspace_collision"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    originalAccounts = listQueryAccountIds(cfg).map(id => ({ id, account: resolveQueryAccount(cfg, id) }))
      .filter(item => item.account.enabled && item.account.configured).map(item => ({ id: item.id, url: item.account.url }));
    if (dryRun) return { status: "validated", agentId, accountId, workspace, existing_accounts: originalAccounts.map(item => item.id), dry_run: true };
    if (!await ready(originalAccounts, timeout)) fail("existing_accounts_not_ready");
    await mkdir(workspace);
    ownsWorkspace = true;
    ownedFiles.set(MARKER, marker);
    await writeFile(join(workspace, MARKER), marker, { flag: "wx", mode: 0o600 });
    await writeAgentProfileFiles({ workspaceDir: workspace, beforeWrite: (file, content) => ownedFiles.set(file, content), profile: { personality: manifest.agent.personality, mission: manifest.agent.mission } });
    // Durable receipt before commit; contains no connection URL or token.
    const activationPath = join(workspace, ACTIVATION);
    const pendingText = activationText(agentId, accountId, fingerprint(manifest), "pending_activation", [...originalAccounts.map(account => account.id), accountId]);
    ownedFiles.set(ACTIVATION, pendingText);
    await writeFile(activationPath, pendingText, { flag: "wx", mode: 0o600 });
    const deferredActivation = cfg.gateway?.reload?.mode === "off";
    const writeResult = await deps.config.mutateConfigFile({
      base: "source",
      afterWrite: deferredActivation
        ? { mode: "none", reason: "Query provisioning awaits operator-controlled Gateway activation" }
        : { mode: "auto" },
      mutate: draft => {
      if (inspect(draft as QueryConfig) !== "absent") fail("concurrent_configuration_change");
      const channel = (draft as QueryConfig).channels!.query!;
      if (!equal(channel, source.channels?.query) || !equal(draft.agents, source.agents) || !equal(draft.bindings, source.bindings)) fail("concurrent_configuration_change");
      storeProvisionAgent(draft, newAgent);
      draft.bindings!.push(structuredClone(newBinding) as never);
      channel.accounts = { ...channel.accounts, [accountId]: structuredClone(newAccount) };
      mutationAttempted = true;
    } });
    committed = true;
    const followUp = (writeResult as unknown as { followUp?: { requiresRestart?: boolean } })?.followUp;
    if (deferredActivation || followUp?.requiresRestart) {
      return { status: "pending_activation", agentId, accountId, workspace,
        connection: "not_checked", requires_restart: true };
    }
    if (!await ready([...originalAccounts, { id: accountId, url: manifest.connection.url }], timeout)) fail("account_readiness_timeout");
    const readyText = activationText(agentId, accountId, fingerprint(manifest), "ready", [...originalAccounts.map(account => account.id), accountId]);
    await writeFile(activationPath, readyText, { mode: 0o600 });
    ownedFiles.set(ACTIVATION, readyText);
    return { status: "created", agentId, accountId, workspace, connection: "ready", restored_accounts: originalAccounts.map(item => item.id) };
  } catch (error) {
    let rollback = "not_needed";
    try {
      if (mutationAttempted) {
        await deps.config.mutateConfigFile({ afterWrite: { mode: "auto" }, mutate: draft => {
          const cfg = draft as QueryConfig;
          const account = cfg.channels?.query?.accounts?.[accountId];
          const agent = provisionAgents(cfg).find(item => item.id === agentId);
          const binding = cfg.bindings?.find(item => equal(item, newBinding));
          if (!account && !agent && !binding) return;
          if (!equal(account, newAccount) || !equal(agent, newAgent) || !binding) fail("rollback_conflict");
          delete cfg.channels!.query!.accounts![accountId];
          storeProvisionAgent(cfg, newAgent, true);
          cfg.bindings = cfg.bindings!.filter(item => !equal(item, newBinding));
        } });
        committed = false;
        rollback = await ready(originalAccounts, timeout) ? "restored" : "recovery_pending";
      }
      if (!committed) await cleanup();
    } catch { rollback = "manual_recovery_required"; }
    // Never return transport/config errors: they may contain the URL/token.
    const publicErrors = new Set([
      "manifest_version_unsupported", "manifest_invalid", "manifest_identity_mismatch",
      "connection_url_invalid", "connection_wss_required", "query_provision_host_not_initialized",
      "workspace_parent_symlink", "query_provision_locked", "global_query_token_conflict",
      "agent_account_or_binding_collision", "workspace_collision", "connection_already_assigned",
      "manifest_collision", "existing_accounts_not_ready", "concurrent_configuration_change",
      "account_readiness_timeout", "source_configuration_invalid",
    ]);
    const code = error instanceof Error && publicErrors.has(error.message) ? error.message : "provision_failed";
    return { status: "failed", error: code, agentId, accountId, workspace, rollback };
  } finally {
    if (lock) await rmdir(lock).catch(() => undefined);
  }
}

// Post-restart verification never edits configuration or guesses an execution identity.
export async function verifyPendingProvisionActivations(deps: ProvisionDependencies) {
  const cfg = structuredClone(deps.config.current()) as QueryConfig;
  const accounts = listQueryAccountIds(cfg).map(id => ({ id, account: resolveQueryAccount(cfg, id) }))
    .filter(item => item.account.enabled && item.account.configured).map(item => ({ id: item.id, url: item.account.url }));
  const results: Array<{ agentId: string; accountId: string; status: string }> = [];
  for (const agent of provisionAgents(cfg)) {
    const workspace = resolve((deps.workspace ?? resolveAgentWorkspaceDir)(cfg, agent.id));
    let state: ActivationState;
    let marker: { agentId: string; accountId: string; fingerprint: string };
    try {
      state = JSON.parse(await readFile(join(workspace, ACTIVATION), "utf8"));
      marker = JSON.parse(await readFile(join(workspace, MARKER), "utf8"));
    } catch { continue; }
    if (!state || !marker || !Array.isArray(state.expectedAccountIds) || state.version !== 1 || state.status !== "pending_activation" || state.agentId !== agent.id ||
        marker.agentId !== state.agentId || marker.accountId !== state.accountId ||
        marker.fingerprint !== state.fingerprint) continue;
    const routeExists = cfg.bindings?.some(binding => binding.type === "route" &&
      binding.agentId === agent.id && binding.match.channel === "query" &&
      binding.match.accountId === state.accountId);
    const ready = !!routeExists && accounts.some(account => account.id === state.accountId) &&
      state.expectedAccountIds.every(id => accounts.some(account => account.id === id)) &&
      await (deps.waitReady ?? waitProvisionReady)(accounts, deps.timeoutMs ?? 60000).catch(() => false);
    const status = ready ? "ready" : "activation_failed";
    await writeFile(join(workspace, ACTIVATION), activationText(state.agentId, state.accountId, state.fingerprint, status, state.expectedAccountIds), { mode: 0o600 });
    results.push({ agentId: state.agentId, accountId: state.accountId, status });
  }
  return results;
}

export function registerQueryProvision(api: OpenClawPluginApi) {
  api.on("gateway_start", async () => {
    const results = await verifyPendingProvisionActivations({ config: api.runtime.config });
    for (const result of results) api.logger.info(`Query provision activation ${result.agentId}: ${result.status}`);
  });
  api.registerTool(ctx => {
    if (ctx.senderIsOwner !== true || ctx.sandboxed || ctx.oneShotCliRun) return null;
    return { name: "query_agent_provision", label: "Query: aprovisionar agente",
    description: "Provisiona un manifiesto Query con una sola mutacion; valida la reconexion de todas las cuentas. Solo para el agente administrador autorizado.",
    parameters: Type.Object({ manifest: ProvisionManifestSchema, dry_run: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const input = params as { manifest: unknown; dry_run?: boolean };
      const result = await provisionQueryAgent(input.manifest, input.dry_run === true, { config: api.runtime.config });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }; }, { optional: true, names: ["query_agent_provision"] });
}
