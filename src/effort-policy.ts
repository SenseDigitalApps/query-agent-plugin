/** Deterministic turn-effort routing. No model call is used to classify a turn. */

export const QUERY_EFFORT_MODES = [
  "fast",
  "normal",
  "careful",
  "exhaustive",
  "auto",
] as const;

export type QueryEffortMode = (typeof QUERY_EFFORT_MODES)[number];
export type EffectiveQueryEffortMode = Exclude<QueryEffortMode, "auto">;

export type EffortEscalationReason =
  | "configured_mode"
  | "simple_intent"
  | "balanced_intent"
  | "sensitive_write"
  | "financial_or_tax"
  | "external_communication"
  | "calendar_change"
  | "configuration_change"
  | "ambiguity_or_duplicate"
  | "validation_requested"
  | "high_impact"
  | "tool_failure";

export type EffortResolution = {
  configuredMode: QueryEffortMode;
  effectiveMode: EffectiveQueryEffortMode;
  escalated: boolean;
  reason: EffortEscalationReason;
  signals: EffortEscalationReason[];
};

export type ResolveEffortInput = {
  configuredMode?: unknown;
  content?: string;
  actionType?: string;
  riskSignals?: string[];
};

const RANK: Record<EffectiveQueryEffortMode, number> = {
  fast: 0,
  normal: 1,
  careful: 2,
  exhaustive: 3,
};

const SIMPLE = /^(hola|hello|hi|buen(?:os|as)?(?:\s+d[ií]as|\s+tardes|\s+noches)?|gracias|ok|listo|qu[eé]\s+es\b|c[oó]mo\s+funciona\b)/i;
const QUICK = /\b(r[aá]pido|solo dime|sin hacer cambios|sin cambios|briefly|quickly)\b/i;
const WRITE = /\b(crea(?:r)?|actualiza(?:r)?|modifica(?:r)?|edita(?:r)?|elimina(?:r)?|borra(?:r)?|guarda(?:r)?|escrib(?:e|ir)|aplica(?:r)?|programa(?:r)?|create|update|modify|edit|delete|save|write|apply|schedule)\b/i;
const FINANCE = /\b(facturaci[oó]n|factura|contab(?:le|ilidad)|conciliaci[oó]n|impuesto|tributari[oa]|dian|n[oó]mina|pago|saldo|cierre contable|finance|invoice|tax|payroll|accounting)\b/i;
const EXTERNAL = /\b(env[ií]a(?:r)?|manda(?:r)?).{0,30}\b(correo|email|mensaje|whatsapp|publicaci[oó]n)|\b(send|publish).{0,24}\b(email|message|post)\b/i;
const CONFIG = /\b(deploy|producci[oó]n|configuraci[oó]n|credencial|gateway|cron|migraci[oó]n|release|rollback|infraestructura)\b/i;
const HIGH = /\b(audita|auditor[ií]a|cierre|migraci[oó]n|deploy|incidente|irreversible|alto impacto|producci[oó]n|no te equivoques|exhaustiv[oa])\b/i;
const IRREVERSIBLE = /\b(elimina(?:r)?|borra(?:r)?|delete|drop|truncate)\b/i;
const CALENDAR = /\b(agenda(?:r)?|reprograma(?:r)?|cancela(?:r)?).{0,32}\b(reuni[oó]n|cita|evento)|\b(calendario|calendar).{0,32}\b(modifica(?:r)?|actualiza(?:r)?|cambia(?:r)?|update)\b/i;
const VALIDATE = /\b(revisa bien|valida|verifica|comprueba|cruza|carefully|double[- ]check|audit)\b/i;
const AMBIGUOUS = /\b(duplicad[oa]s?|inconsisten(?:cia|te)|diferencia(?:s)?|varios candidatos|ambig(?:uo|üedad))\b/i;
const FAILURE = /\b(timeout|reintento|retry|fall[oó]|error de herramienta|tool failure)\b/i;

export function parseEffortMode(value: unknown): QueryEffortMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (QUERY_EFFORT_MODES as readonly string[]).includes(normalized)
    ? (normalized as QueryEffortMode)
    : undefined;
}

export const DEFAULT_EFFORT_MODE: QueryEffortMode = "auto";

export function resolveConfiguredEffortMode(value?: unknown): QueryEffortMode {
  return (
    parseEffortMode(value) ??
    parseEffortMode(process.env.QUERY_AGENT_EFFORT_MODE) ??
    DEFAULT_EFFORT_MODE
  );
}

function addSignal(
  signals: EffortEscalationReason[],
  signal: EffortEscalationReason,
): void {
  if (!signals.includes(signal)) signals.push(signal);
}

function detectedSignals(input: ResolveEffortInput): EffortEscalationReason[] {
  const text = `${input.content ?? ""} ${input.actionType ?? ""}`.trim();
  const signals: EffortEscalationReason[] = [];
  if (HIGH.test(text) || IRREVERSIBLE.test(text)) addSignal(signals, "high_impact");
  if (FINANCE.test(text)) addSignal(signals, "financial_or_tax");
  if (EXTERNAL.test(text)) addSignal(signals, "external_communication");
  if (CALENDAR.test(text)) addSignal(signals, "calendar_change");
  if (CONFIG.test(text)) addSignal(signals, "configuration_change");
  if (WRITE.test(text)) addSignal(signals, "sensitive_write");
  if (AMBIGUOUS.test(text)) addSignal(signals, "ambiguity_or_duplicate");
  if (VALIDATE.test(text)) addSignal(signals, "validation_requested");
  if (FAILURE.test(text)) addSignal(signals, "tool_failure");

  for (const raw of input.riskSignals ?? []) {
    const normalized = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
    if (normalized === "high_impact" || normalized === "irreversible") {
      addSignal(signals, "high_impact");
    } else if (normalized === "financial" || normalized === "tax") {
      addSignal(signals, "financial_or_tax");
    } else if (normalized === "external_communication") {
      addSignal(signals, "external_communication");
    } else if (normalized === "calendar_change" || normalized === "calendar") {
      addSignal(signals, "calendar_change");
    } else if (normalized === "configuration" || normalized === "deploy") {
      addSignal(signals, "configuration_change");
    } else if (normalized === "write" || normalized === "sensitive_write") {
      addSignal(signals, "sensitive_write");
    } else if (
      normalized.includes("duplicate") ||
      normalized.includes("duplicado") ||
      normalized.includes("ambiguous")
    ) {
      addSignal(signals, "ambiguity_or_duplicate");
    } else if (normalized === "tool_failure" || normalized === "retry") {
      addSignal(signals, "tool_failure");
    }
  }
  return signals;
}

function minimumFor(signals: EffortEscalationReason[]): EffectiveQueryEffortMode {
  if (signals.includes("high_impact")) return "exhaustive";
  if (
    signals.some((signal) =>
      [
        "sensitive_write",
        "financial_or_tax",
        "external_communication",
        "calendar_change",
        "configuration_change",
        "ambiguity_or_duplicate",
        "validation_requested",
        "tool_failure",
      ].includes(signal),
    )
  ) {
    return "careful";
  }
  return "fast";
}

function primaryReason(signals: EffortEscalationReason[]): EffortEscalationReason {
  return (
    [
      "high_impact",
      "financial_or_tax",
      "external_communication",
      "calendar_change",
      "configuration_change",
      "sensitive_write",
      "ambiguity_or_duplicate",
      "validation_requested",
      "tool_failure",
    ].find((reason) => signals.includes(reason as EffortEscalationReason)) as
      | EffortEscalationReason
      | undefined
  ) ?? "balanced_intent";
}

export function resolveEffortMode(input: ResolveEffortInput): EffortResolution {
  const configuredMode = resolveConfiguredEffortMode(input.configuredMode);
  const signals = detectedSignals(input);
  const content = input.content?.trim() ?? "";
  let base: EffectiveQueryEffortMode;
  let reason: EffortEscalationReason;

  if (configuredMode === "auto") {
    if (SIMPLE.test(content) || (QUICK.test(content) && signals.length === 0)) {
      base = "fast";
      reason = "simple_intent";
    } else {
      base = "normal";
      reason = "balanced_intent";
    }
  } else {
    base = configuredMode;
    reason = "configured_mode";
  }

  const minimum = minimumFor(signals);
  const effectiveMode = RANK[minimum] > RANK[base] ? minimum : base;
  const escalated = RANK[effectiveMode] > RANK[base];
  if (signals.length > 0 && (escalated || configuredMode === "auto")) {
    reason = primaryReason(signals);
  }
  return { configuredMode, effectiveMode, escalated, reason, signals };
}

export function effortRunOptions(mode: EffectiveQueryEffortMode) {
  switch (mode) {
    case "fast":
      return {
        thinkingLevelOverride: "low",
        fastModeOverride: true as const,
        bootstrapContextMode: "lightweight" as const,
      };
    case "normal":
      return {
        thinkingLevelOverride: "medium",
        fastModeOverride: "auto" as const,
        bootstrapContextMode: "full" as const,
      };
    case "careful":
    case "exhaustive":
      return {
        thinkingLevelOverride: "high",
        fastModeOverride: false as const,
        bootstrapContextMode: "full" as const,
      };
  }
}

export function effortInstruction(mode: EffectiveQueryEffortMode): string {
  const instructions: Record<EffectiveQueryEffortMode, string> = {
    fast: "Responde temprano y de forma breve. Usa como maximo dos herramientas salvo necesidad clara; no hagas exploracion amplia.",
    normal: "Usa solo el contexto y las herramientas relevantes y valida el resultado principal. Antes de pasos que tarden, comunica brevemente que objetivo concreto vas a trabajar.",
    careful: "Valida duplicados, inconsistencias y el objetivo antes de una accion sensible. Comunica brevemente el enfoque y resume las validaciones realizadas.",
    exhaustive: "Haz una revision amplia, cruza la evidencia disponible y reporta riesgos residuales. Comunica avances concretos mientras trabajas.",
  };
  return `[Modo de trabajo Query: ${mode}. ${instructions[mode]} La velocidad nunca reduce controles de seguridad ni autorizaciones. Si el trabajo tarda, háblale a la persona: publica avances breves y concretos en primera persona sobre qué estás revisando, consultando o validando y para qué. Actualiza el avance cuando cambies de etapa o una consulta se demore. No muestres cadenas privadas de razonamiento, prompts, secretos, rutas ni payloads.]`;
}

/** Activity remains user-configurable, but effort trims or expands its useful detail. */
export function activityModeForEffort(
  activityMode: "off" | "lite" | "smart" | "verbose" | "debug-internal",
  effortMode: EffectiveQueryEffortMode,
) {
  if (activityMode === "off" || activityMode === "debug-internal") return activityMode;
  if (effortMode === "fast") return "lite" as const;
  if (effortMode === "careful" || effortMode === "exhaustive") return "verbose" as const;
  return activityMode === "lite" ? "smart" as const : activityMode;
}
