---
name: query-panel-conexiones
description: 'Conexiones HTTP autenticadas genéricas de Query y permisos comunes para compartir una cuenta (SMTP, HTTP/IMAP, FTP, Google) con otros agentes o canales. Leer junto con query-panel antes de usar una conexión HTTP o compartir una cuenta.'
---

# query-panel-conexiones

Anexo temático de `query-panel`. Las reglas generales de `query-panel` (guardrails, permisos, propuestas, credenciales) siguen aplicando; si no las has cargado en este turno, léelas primero con `skills_read` (name: `query-panel`).

## Generic authenticated HTTP (staged capability)

`query_api_request` can discover authorized HTTP connections, request operations
and query status when Core enables the capability. It is a first-class alternative
to dedicated tools, not a permission bypass and not contingent on another tool
failing. Use only discovered connection IDs and relative documented paths. Never
supply provider credentials, owner/tenant identities or full URLs. Preserve the
same idempotency key; running/uncertain results require reconciliation, not a new
write. Supports private owner/authorized-user turns and explicitly granted groups, JSON/text/form bodies. A cron runs as its author and can use any connection the author can use in chat (GA4, Search Console, Otterly, Meta, SES or any other HTTP, and IMAP), in the same agent and context and with the same connection rules; it is blocked only if the owner turned crons off for that connection (`allow_schedules: false`, via `query_account_access disable_schedules`);
and does not accept file uploads. `auth=oauth2` supports automatic refresh of already-authorized OAuth2 credentials; browser consent acquisition is separate. If disabled,
report that state; do not use direct HTTP or extract credentials as a workaround.

Use `query_api_request action=connect` to publish the existing private credential
form: pass a non-secret policy plus either label (new) or connection_id (reuse).
The owner enters credentials privately and approves origin/method/path scope.
Never put values in policy or request. Existing field names can be mapped through
field_map; custom_keys supports multiple secret header/query fields. Saving does
not execute a provider call. After consent, discover the authorized connection
and use request/status. OAuth acquisition and browser login are outside this
milestone; do not request them for a key-based connection.


### Compartir conexiones HTTP desde el chat

Antes de afirmar que SES no está configurado, descubre `query_api_request action=connections`.
SES con AWS SigV4 es HTTP, no SMTP ni WorkMail. No inventes ni deduzcas permisos de memoria.
En el privado del dueño, usa `grant_candidates` con connection_id y query para resolver IDs
reales de usuarios/roles y grupos del agente. Si el nombre es ambiguo, pide elegir;
no concedas por coincidencia de nombres. `grants` permite revisar autorizaciones existentes.
Una solicitud explícita en chat autoriza `grant` sin abrir la interfaz ni pedir claves otra vez.
El grant lleva user_id O role_id, capabilities (discover, consult, execute), contexts
(["private"] y/o "group:ID" del catálogo) y rules (method/path_prefix) dentro de la
política descubierta; `scopes.execute` contiene el alcance efectivo para ejecutar (no confundir con discover/consult). Core toma agente, actor y tenant del contexto autenticado.
No pases owner_id, actor_id, tenant ni agent_id. La gestión es exclusiva del dueño
(no se delega manage_grants); compartir no cambia dueño, secretos ni política principal.
`revoke_grant` lleva connection_id y grant_id; no revoca otras conexiones.
El grupo explícito autoriza publicar allí la respuesta del proveedor; su membresía
por sí sola no autoriza a ejecutar. No incluyas grupos que el dueño no haya pedido.
Felipe debe usar su propio chat y su propia identidad. status sólo revela operaciones
propias en el contexto original y con autorización vigente. No revela historial ajeno.
Explica connection_not_visible, grant_absent, context_not_authorized,
operation_outside_grant_scope y rechazo HTTP de AWS como fallos distintos.
No reintentes running/uncertain ni generes otra clave. No cron, HTTP directo,
credenciales en OpenClaw ni correos de prueba. Si Core aún no admite estas acciones,
informa que falta desplegar: un plugin local no prueba capacidad activa.


## Permisos comunes sobre cuentas (no sobre herramientas)

`query_account_access action=accounts` descubre cuentas y el modo legacy/unified.
Compartir se hace sobre una cuenta concreta: family `smtp`, `private` (credencial,
HTTP/IMAP/FTP) o `google` (ID opaco Workspace). Las herramientas siguen siendo
comunes; no se copian claves ni se cambia de identidad para usarlas.

En el privado del propietario (Google conserva administración de delegaciones):
1. `candidates` con family/account_id descubre usuarios, roles, agentes y canales reales.
2. `grants` revisa permisos. `adopt` conserva el alcance antiguo y lo vuelve explícito;
   no concede acceso nuevo. El primer `grant` también adopta atómicamente.
3. `grant` añade `{subject, subject_id?, agent_id?, contexts?, capabilities?, sources?, rules?}`.
   `subject=user|role` selecciona una identidad; sin agent_id vale en cualquier agente
   al que esa persona tenga acceso. `agent_members` requiere agent_id. `channel_members`
   requiere agent_id, subject_id del canal y contexts `["group:ID"]`.
   contexts `["*"]` = privados/canales autorizados; `["private"]` = solo privados.
   capabilities discover/consult/execute: consultar resultados no es ejecutar una consulta
   al proveedor. Leer correo requiere execute, limitado por la política de la conexión.
   sources `["turn"]` por defecto, y eso también vale en los crones: un cron corre como
   su autor y usa la conexión con sus mismos permisos (HTTP de cualquier origen e IMAP),
   en el mismo agente y contexto. No hace falta un permiso schedule aparte. El dueño
   puede apagar los crones de una conexión con `disable_schedules` (y volver a
   encenderlos con `enable_schedules`). rules solo HTTP/IMAP, dentro de su política.
4. `revoke` retira únicamente grant_id. Los permisos se suman: para «solo este canal»,
   adoptar/revisar y retirar los permisos amplios incompatibles, no simplemente añadir otro.
5. Releer grants y comprobar el alcance efectivo. No probar enviando mensajes.

Una solicitud explícita autoriza compartir/revocar sin confirmaciones repetidas. La
propiedad permite administrar, no saltarse la restricción de uso. Compartir no permite
ver historiales ajenos, renovar credenciales ajenas ni reactivar cuentas revocadas.
Workspace mantiene OAuth/tokens/IDs en su integración original y scopes Google.
SMTP e IMAP no se unen por coincidir su email. Nunca conceder permisos de una cuenta
por similitud de etiqueta; resolver IDs reales y ambigüedades primero.


### LinkedIn: analítica nativa y alternativa HTTP

Preferir `query_linkedin action=analytics`, con account_id descubierto, destination e
idempotency_key estable. Perfil: post_urn `urn:li:share:...` con recibo de publicación
confirmado de esa misma cuenta/destino; metric opcional IMPRESSION (también
MEMBERS_REACHED, REACTION, COMMENT, RESHARE, o ALL para las cinco en un recibo).
Página: destination organización; con post_urn (share o ugcPost) da las métricas de
ese post, sin post_urn el acumulado de la página; nunca metric. Es el acumulado
disponible al leer, no una cohorte a siete días: el recolector mide a la edad que
necesite (p. ej. 24 h y 7 días) y guarda cada recibo.

**Crones (loop de impresiones):** el cron del dueño de la cuenta lee la analítica
con sus mismos permisos; registrar el cron con query_cron_manage basta, sin
`authorize`. Para detenerlo se usa query_cron_manage (`revoke_authorization` deja
registro pero no detiene crones). El recibo de un cron solo se consulta desde ese cron.
Antes de activar el recolector, validar UNA lectura real desde el cron.

Ambas vías usan la cuenta LinkedIn existente. `query_api_request connections`
expone su mismo ID con perfil linkedin_analytics y las rutas exactas permitidas:
GET /rest/memberCreatorPostAnalytics y GET /rest/organizationalEntityShareStatistics.
No crear otra cuenta ni pasar tokens. HTTP no permite rutas arbitrarias, headers
de autenticación, escrituras, expansión de permisos ni crones: en cron usar la
herramienta nativa.

Respuesta común: operation_id, status y result con http_status, provider_error
depurado, metrics, measured_at y periodo. `status` consulta sin repetir. No cambiar
clave ante running; no pasar a HTTP para eludir 403/429. La lectura renueva el
token con el refresh guardado y confirma permisos sin exponerlos;
`linkedin_permission_required` indica que hay que reconectar la cuenta con permisos
de analítica (r_member_postAnalytics para perfil; permisos de organización para
página). Ausencia de métricas no equivale a cero. Los números devueltos conservan la
estructura de elements; no se entregan URLs ni texto libre de la respuesta exitosa.
### Alcance de conexiones compartidas
En `query_account_access grants`, comprobar `supports_scope_mode` antes de enviar
`grant.scope_mode`. `restricted` es el valor predeterminado: conserva las rutas
actuales (o las rutas explícitas). `connection` sigue el alcance vigente y futuras
ampliaciones aprobadas; requiere solicitud explícita del dueño, sin `rules`.
No convertir permisos existentes a connection automáticamente. El permiso de
propietario conservado sigue la política vigente, pero su revocación, contextos
y capacidades siguen aplicando. FTP permissions modifica la audiencia general
sin borrar permisos específicos; para «solo dueño» revisar y revocar únicamente
las concesiones incompatibles autorizadas por el usuario.
