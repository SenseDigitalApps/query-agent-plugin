# SMTP en Query

Herramientas registradas por query-tools desde index.ts y tools-entry.ts:
query_smtp_accounts, query_smtp_grants, query_smtp_preauthorize,
query_smtp_connect, query_smtp_revoke, query_smtp_disconnect, query_smtp_send.

Administración: autorizar dirección exacta, usuario y servidor. Autoservicio:
Conectar → formulario autenticado de Query → contraseña → conexión validada.
Nunca solicites ni transportes contraseñas en herramientas, chat o configuración
de OpenClaw. SMTP vive en Core; Google Workspace conserva su implementación.

Las respuestas path son rutas relativas al frontend del tenant de Query.
Preséntalas como enlaces o dirige al usuario a Mis cuentas de correo.
Para enviar, propone el contenido con account_id e idempotency_key estable.
El usuario revisa y pulsa Autorizar y enviar en Query. No hace falta volver
a llamar send salvo que quede aprobado sin ejecutar. No reintentes uncertain.
Conectar no autoriza campañas. Un cron no tiene permiso en este alcance.

Compilar con npm run build al preparar despliegue; npm run check y npm test
antes de empaquetar. No se modifican compilados ni se reinicia el Gateway.
Si la instalación usa una allowlist de herramientas, añade exclusivamente
estos siete nombres; no requiere herramientas administrativas del Gateway.
