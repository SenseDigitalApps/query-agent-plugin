# Stop desde Query

El canal acepta `turn.abort` exclusivamente por el socket autenticado de Core,
con `thread_id`, `client_msg_id` del intento y `data.request_id`. Core valida
autor, permisos y tenant antes de emitirlo. Se busca la ejecución local exacta;
no se aceptan sesiones ni run IDs proporcionados por la app.

`onAgentRunStart` registra la identidad de la ejecución. `sessions.abort` se llama
con `{key, runId}` por el SDK público `callGatewayTool`, usando la configuración
del servidor. Después se interrumpe el dispatch local con `abortSignal`. No hay
fallback global. Compatibilidad contrastada: OpenClaw 2026.9.4; otros runtimes
requieren verificar estos contratos antes de publicar.

Sólo se confirma Stop al recibir `status: aborted` para ese `abortedRunId` y
terminar el dispatch (o al cancelar antes de la admisión). Se persiste el terminal
en ResponseStore. RPC fallido/no-active-run no equivale a confirmación. No se
deshacen efectos ya realizados ni se cancelan propuestas pendientes.

Construir con `npm run build`; publicar junto al endpoint `/messages/{id}/stop/`
de Core y los clientes actualizados. Las pruebas `stop.test.ts`, `turn-stop.test.ts`
y `inbound-dispatch.test.ts` usan simulaciones, sin proveedor ni llamadas de pago.
Falta la validación contra el Gateway desplegado y sus subagentes reales.
