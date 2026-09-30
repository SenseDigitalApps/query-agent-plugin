import { expect, it, vi } from "vitest";
import { agentSocketIdentity, resolveVoiceTarget } from "./voice-target.js";
import type { QueryConfig } from "./types.js";
import type { VoiceScope } from "./voice-bridge.js";

const scope = (agent_id: number, tenant = "public"): VoiceScope =>
  ({call_id: "f98a57d5-3587-4794-bc8f-58dc71de7391", tenant, user_id: 13, thread_id: 13, agent_id});
const cfg = (voice?: unknown): QueryConfig => ({channels: {query: {
  ...(voice ? {voice} : {}),
  accounts: {
    query: {url: "wss://apius.itsquery.com/ws/openclaw-agent/3/", token: "t1"},
    lia: {url: "wss://apius.itsquery.com/ws/openclaw-agent/5/", token: "t2"},
    director: {url: "wss://apiasocapitales.itsquery.com/ws/openclaw-agent/1/", token: "t3"},
    nocturnos: {url: "wss://apinocturnos.itsquery.com/ws/openclaw-agent/1/", token: "t4"},
  },
}}} as QueryConfig);
const route = vi.fn((params: {accountId: string; peer: {id: string}}) =>
  ({sessionKey: `agent:${params.accountId}:query:direct:${params.peer.id}`, agentId: params.accountId}));

it("finds the one account whose socket host and bot id match the call", () => {
  expect(resolveVoiceTarget(cfg(), scope(3), route, "apius.itsquery.com")).toMatchObject({
    accountId: "query", agentId: "query", sessionKey: "agent:query:query:direct:13",
    coreApiBase: "https://apius.itsquery.com/api/v4/",
  });
  // Same bot id in two tenants: the host decides, never the id alone.
  expect(resolveVoiceTarget(cfg(), scope(1, "tenant_asocapitales"), route, "apiasocapitales.itsquery.com")?.accountId).toBe("director");
  expect(resolveVoiceTarget(cfg(), scope(1), route, "apinocturnos.itsquery.com")?.accountId).toBe("nocturnos");
});

it("refuses when nothing or more than one account matches, or the host is missing or malformed", () => {
  expect(resolveVoiceTarget(cfg(), scope(99), route, "apius.itsquery.com")).toBeUndefined();
  expect(resolveVoiceTarget(cfg(), scope(3), route, undefined)).toBeUndefined();
  expect(resolveVoiceTarget(cfg(), scope(3), route, "evil.example/ws")).toBeUndefined();
  expect(resolveVoiceTarget(cfg(), scope(3), route, "other.itsquery.com")).toBeUndefined();
  const duplicated = cfg();
  (duplicated.channels!.query!.accounts as Record<string, {url: string; token: string}>).copy =
    {url: "wss://apius.itsquery.com/ws/openclaw-agent/3/", token: "t9"};
  expect(resolveVoiceTarget(duplicated, scope(3), route, "apius.itsquery.com")).toBeUndefined();
});

it("an explicit route overrides the automatic match", () => {
  const withRoute = cfg({routes: [{tenant: "public", agentId: 3, accountId: "lia"}]});
  expect(resolveVoiceTarget(withRoute, scope(3), route, "apius.itsquery.com")?.accountId).toBe("lia");
});

it("reads host and bot id only from Query agent sockets", () => {
  expect(agentSocketIdentity("wss://APIus.itsquery.com:443/ws/openclaw-agent/3/?token=x")).toEqual({host: "apius.itsquery.com", botId: "3"});
  expect(agentSocketIdentity("wss://apius.itsquery.com/ws/other/3/")).toBeUndefined();
  expect(agentSocketIdentity("not a url")).toBeUndefined();
});
