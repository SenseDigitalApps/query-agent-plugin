# SMTP desde el chat

Herramientas: query_smtp_accounts, query_smtp_grants, query_smtp_preauthorize,
query_smtp_connect, query_smtp_revoke, query_smtp_disconnect, query_smtp_prefer,
query_smtp_setup y query_smtp_send. Mantener las nueve en la allowlist.

Todo se completa desde la conversación. La página de cuentas es opcional para
revisar. setup crea la cuenta propia con email/host/port/tls/login opcional;
connect reconecta una existente. La contraseña se entrega a Core mediante la
entrada privada dentro del chat; nunca viaja como mensaje ni parámetro de tool.

send ofrece propose, revise, send, approve, status, submissions, cancel y retry.
Una solicitud explícita de envío permite proponer y enviar en el mismo turno,
sin otra confirmación. Un borrador se conserva hasta que el usuario pida enviarlo;
«aprobada» basta si la propuesta es inequívoca. Core vincula la operación al
mensaje humano firmado. Renovar credenciales antiguas con auth.refresh.

attachment_ids usa archivos del hilo (hasta 20 archivos y 20 MiB en total) sobre
la misma cuenta SMTP; no usar un skill local distinto para adjuntos. revise
cambia el mismo submission_id, incluidos adjuntos y new_account_id. Usar el
expected_digest devuelto al editar/enviar. No modificar correos ya procesados.

accepted significa aceptación SMTP, no llegada al buzón. No repetir accepted ni
uncertain. retry sólo reintenta rejected tras una nueva solicitud del usuario y
conserva idempotencia. Preguntar únicamente ante ambigüedad real. Conectar por sí
solo no pide enviar; si ya había una solicitud de envío, continuar tras conectar.

Requiere Core con migración bot_gateway.0013_smtp_chat, backend y frontend nuevos.
Compilar con npm run build, comprobar con npm run check y ejecutar pruebas SMTP
y tool-contract. Actualizar también skills/query-panel/SKILL.md en el despliegue.
Los crones autorizados pueden consultar cuentas y preparar/enviar correo con adjuntos usando la cuenta conectada de su identidad de ejecución. No requieren confirmación en cada ejecución. Usa una clave de idempotencia por ocurrencia programada y correo, estable ante reintentos; nunca generes otra para repetir accepted/uncertain/rejected. No pueden configurar cuentas, administrar permisos ni usar retry. Si falta conexión, informa en el chat para conectarla allí. FTP usa query_ftp_accounts y allow_schedules; una limitación de LinkedIn no invalida FTP ni SMTP.
