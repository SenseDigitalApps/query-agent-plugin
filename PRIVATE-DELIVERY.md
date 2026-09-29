# Entrega privada en Query

Herramientas registradas desde query-tools y las entradas habituales del plugin:
query_private_accounts, query_private_request, query_private_revoke,
query_private_operation. No necesitan administración global del Gateway.

Cuando alguien quiere configurar una clave o token: consulta el catálogo y las
cuentas, identifica la cuenta y solicita la entrega privada. Query publica un
botón en el chat privado del titular. Nunca pidas pegar valores en mensajes,
argumentos de herramientas, adjuntos o comandos. Para SMTP utiliza las
herramientas SMTP existentes. Gmail conserva su flujo.

OpenAI y LinkedIn se ejecutan mediante adaptadores del backend; el plugin no
recibe ni instala valores en archivos locales. Esto no cambia la clave global
del proveedor de modelos de OpenClaw. El usuario renueva cada cuenta desde Query.
Las credenciales se limitan a tenant, usuario, cuenta y agente. No se heredan por
otras personas que hablen con el mismo agente ni por cron o sesiones de soporte.

Proponer una operación no la ejecuta: el titular ve contenido y destino y
autoriza desde Query. Información protegida requiere un consentimiento adicional
para ser analizada por OpenAI; compartir el resultado con el agente es opcional.
Un resultado incierto nunca se reintenta automáticamente ni con una clave nueva.

La instalación requiere backend/frontend de la misma versión, migraciones y
PRIVATE_DELIVERY_ENCRYPTION_KEY; OpenAI requiere un modelo aprobado en Core.
Compilar y desplegar sólo con autorización; no modificar compilados de OpenClaw.

## Credenciales de cualquier servicio

`integration=credential` permite guardar cualquier contraseña, clave, token o conjunto de credenciales (texto/JSON, incluidas claves multilínea). La etiqueta identifica servicio y cuenta sin incluir secretos. El estado `stored` significa guardada, sin consumidor conectado: no se valida externamente ni está disponible para análisis o comandos del agente. Puede renovarse o revocarse independientemente. El uso requiere un adaptador autorizado; no existe lectura genérica de valores.
## LinkedIn: varios destinos por cuenta y cron

Core admite perfiles `urn:li:person:...` y organizaciones
`urn:li:organization:...`. Usa `query_linkedin authorize` por cada destino
solicitado con la misma cuenta y automatización; las autorizaciones coexisten.
El autor guardado es el predeterminado para el flujo interactivo anterior.

Cada `publish` usa un destino exacto autorizado. Core separa idempotencia y
resultados por destino, por lo que la misma clave de ocurrencia puede usarse
para varios destinos. Los resultados incluyen `destination`, `account_id`,
`schedule_external_id` y `operation_id`. Conservar la misma clave en reintentos.

`revoke_authorization` con `destination` revoca sólo ese destino; sin él revoca
todos los destinos de esa cuenta/cron. Core requiere la migración
`bot_gateway.0016_linkedin_automation_destinations`. No hay herramientas nuevas
que registrar: se conserva `query_linkedin` en el manifiesto existente.
