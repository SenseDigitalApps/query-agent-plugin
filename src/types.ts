import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const CHANNEL_ID = "query" as const;
export const DEFAULT_ACCOUNT_ID = "default";

export type QueryChannelConfig = {
  enabled?: boolean;
  url?: string;
  token?: string;
  heartbeatMs?: number;
  origin?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  responseTimeoutMs?: number;
  stateFile?: string;
  ttsVoice?: string;
  ttsLang?: string;
  ttsRate?: string;
  accounts?: Record<string, QueryAccountConfig>;
};

export type QueryAccountConfig = Omit<QueryChannelConfig, "accounts">;

export type ResolvedQueryAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  url: string;
  token: string;
  heartbeatMs: number;
  origin?: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  responseTimeoutMs: number;
  stateFile?: string;
  ttsVoice?: string;
  ttsLang?: string;
  ttsRate?: string;
};

export type QueryConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    query?: QueryChannelConfig;
  };
};

export type QueryAttachment = {
  id?: string | number;
  kind?: "image" | "file" | "audio" | "video" | string;
  name?: string;
  mime_type?: string;
  local_path?: string;
  transcript?: string;
  transcription?: string;
  text?: string;
  duration?: number;
  duration_seconds?: number;
  duration_ms?: number;
  is_voice_note?: boolean;
  voice?: boolean;
    size?: number;
    is_pinned?: boolean;
    expires_at?: string | null;
    url: string;
};

/**
 * Como habla el agente y para que existe, tal como los escribio una persona en
 * el panel de Query.
 *
 * No son metadatos: se escriben en `SOUL.md` e `IDENTITY.md` del workspace, de
 * donde OpenClaw arma el system prompt. Una cadena vacia es una instruccion
 * explicita —"vuelve al comportamiento por defecto"— y no un valor faltante;
 * por eso lo que decide si hay que tocar archivos es la presencia del objeto
 * entero, no la de cada campo.
 */
export type QueryAgentProfile = {
  personality?: string;
  mission?: string;
};

export type QuerySessionReadyEvent = {
  type: "session.ready";
  role?: "system";
  content?: string;
  data: {
    protocol: "query-openclaw.v1" | "query-openclaw.v2" | string;
    bot_id?: string | number;
    display_name?: string;
    thread_id?: string | number;
    general_thread_id?: string | number;
    multi_thread?: boolean;
    /** Ausente en servidores Query anteriores a esta funcion. */
    agent_profile?: QueryAgentProfile;
  };
};

/** Alguien edito el perfil desde Query con el agente ya conectado. */
export type QueryAgentProfileEvent = {
  type: "agent.profile";
  role?: "system";
  content?: string;
  data: QueryAgentProfile & { display_name?: string };
};

export type QueryThreadType = "general" | "topic" | "private";

/**
 * Quien delega, en claro. No es una credencial: no sirve para autenticarse ni
 * para decidir nada del lado de Query, que siempre vuelve a mirar el token.
 * Sirve para que el agente sepa por quien esta actuando sin deducirlo del texto
 * de la conversacion, que es justo donde se equivoca.
 */
export type QueryDelegatedIdentity = {
  id?: number;
  username?: string;
  email?: string;
  display_name?: string;
};

/** Credencial corta con la que el agente actua en nombre del usuario. */
export type QueryDelegatedAuth = {
  token: string;
  expires_at?: string;
  expires_in?: number;
  scopes?: string[];
  /** Ausente en servidores Query anteriores a esta funcion. */
  identity?: QueryDelegatedIdentity;
  /** ``turn`` cuando la pidio una persona; ``schedule`` cuando la pidio un cron. */
  source?: "turn" | "schedule" | string;
};

export type QueryTenant = {
  schema?: string;
  domain?: string;
  subdomain?: string;
  name?: string;
};

export type QueryAuthGrantedEvent = {
  type: "auth.granted";
  role?: "system";
  content?: string;
  client_msg_id?: string;
  thread_id?: string | number;
  data: {
    tenant?: QueryTenant;
    delegated_auth?: QueryDelegatedAuth;
    /** Presente cuando la credencial es de una tarea programada, no de un turno. */
    external_id?: string;
  };
};

/**
 * Que hizo Query con una propuesta al leer el mensaje de la persona.
 *
 * La persona puede cerrar una propuesta escribiendo ("confirmo") en vez de
 * pulsar el boton. Lo resuelve Query, no el agente; esto solo cuenta el
 * resultado para no volver a decir que sigue pendiente algo ya aplicado.
 */
export type QueryResolvedAction = {
  status: "applied" | "failed" | "ambiguous" | "not_allowed";
  decision: "confirm" | "cancel";
  action_id?: string;
  action_type?: string;
  module_label?: string;
  record_id?: number | null;
  error?: string;
  pending?: Array<{
    action_id: string;
    module_label?: string;
    intent?: string;
  }>;
};

export type QueryUserMessageEvent = {
  type: "message";
  role: "user";
  content: string;
  client_msg_id: string;
  thread_id?: string | number;
  event_id?: string | number;
  data?: {
    attachments?: QueryAttachment[];
    resolved_action?: QueryResolvedAction;
    thread_id?: string | number;
    thread_type?: QueryThreadType;
    thread_name?: string;
    tenant?: QueryTenant;
    delegated_auth?: QueryDelegatedAuth;
    sender?: {
      id?: string | number;
      user_id?: string | number;
      name?: string;
      type?: "member" | "support" | string;
      private_thread_id?: string | number | null;
    };
    [key: string]: unknown;
  };
};

export type QueryScheduleCancelEvent = {
  type: "schedule.cancel";
  role: "system";
  content?: string;
  client_msg_id?: string;
  thread_id?: string | number;
  data: {
    external_ids: string[];
    reason?: string;
  };
};

export type QueryInboundEvent =
  | QuerySessionReadyEvent
  | QueryAgentProfileEvent
  | QueryUserMessageEvent
  | QueryScheduleCancelEvent
  | QueryAuthGrantedEvent;

export type QueryActivityState = "queued" | "working" | "done" | "error";

export type QueryAgentActivity = {
  state?: QueryActivityState;
  label: string;
  detail?: string;
  stage?: string;
  toolName?: string;
  progress?: number;
  runId?: string;
};

export type QueryOutboundEvent = {
  type:
    | "activity"
    | "message"
    | "turn.adopted"
    | "error"
    | "schedule.sync"
    | "profile.seed"
    | "auth.refresh"
    | "auth.request";
  role: "assistant" | "system";
  content: string;
  client_msg_id: string;
  thread_id: string;
  data: Record<string, unknown>;
};

export type CachedResponse = {
  threadId: string;
  clientMsgId: string;
  type: "message" | "turn.adopted" | "error";
  content: string;
  data: Record<string, unknown>;
  completedAt: number;
};
