# Matías: contrato Core/plugin

Herramientas registradas: `query_billing_availability`, `query_billing_status`,
`query_billing_emit`, `query_billing_reconcile`, `query_billing_documents`.
Todas usan `POST /api/v4/openclaw-agent/billing/` con
`X-Query-Delegated-Token`, la conexión actual y `thread_id`.

Parámetros comunes: `items: [{module_id, record_id}, ...]`, 1–50 pares únicos.
La acción HTTP corresponde al sufijo de la herramienta. `emit` exige
`user_request`, cita textual de la solicitud explícita del mensaje humano
actual; `documents` admite `formats: ["pdf", "xml"]`.

La instrucción explícita autoriza todo el lote identificado, sin aprobación
adicional. Resolver primero sus IDs. No sustituir la emisión por edición de
campos ni por creación de otro registro. Los permisos siguen siendo los del
usuario efectivo y tenant, verificados por Core. No se admite emitir desde
cron con una autorización interactiva.

Core responde `{tenant, action, ok, requires_confirmation: false, results}`.
Cada resultado conserva `module_id`, `record_id`, `ok`, `http_status`,
`outcome`, `emitted` y los datos/errores de Matías. Revisar todos los elementos:
un lote HTTP 200 puede contener errores.

* `record_created`/`record_exists`: borrador fiscal, no factura emitida. Usar
  `draft.module_id` y `draft.id` para revisar y emitir el registro fiscal bajo
  la misma solicitud cuando sus datos estén listos.
* `queued`: únicamente encolado; consultar después con `status`.
* `issued`/`emitted=true`: emisión efectiva.
* `pending`/`unknown`/`reconciliation_required`: consultar/conciliar, sin reenviar.
  Si no hay prefijo/número, Core puede indicar revisión manual.
* `documents`: resultados por formato con adjuntos descargables del chat;
  no inventar enlaces a la ruta de la interfaz web.

Ante timeout/JSON inválido, el plugin informa `billing_result_unknown`, no
repite la petición y conserva los IDs. Consultar `status` y `reconcile` antes
de considerar cualquier reenvío. `billing_bridge_unavailable` significa que
debe desplegarse el puente Core; la existencia de `/api/matias/` no lo sustituye.

Implementación Core de referencia en el repositorio Query Core:
`core_apps/ai_processing/views_agent_billing.py`,
`services/agent_billing.py` y `docs/agent-electronic-billing.md`.
El puente reutiliza las operaciones Matías en proceso, con sus permisos,
referencia idempotente, bloqueo de factura y emisión Celery tras commit.
No necesita credenciales Matías ni JWT del usuario en el plugin.
