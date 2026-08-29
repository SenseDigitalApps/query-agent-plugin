# Query channel for OpenClaw

Plugin nativo de canal que conecta OpenClaw con la mensajería de Query usada por
el frontend React y la aplicación Flutter. Mantiene un WebSocket persistente por
bot, envía actividad inmediatamente y conserva respuestas terminales para que
un mensaje reenviado por Django no ejecute dos veces las herramientas del agente.

## Requisitos

- OpenClaw `2026.7.1-2` o posterior.
- Node.js `22.22.3+`, `24.15+` o `25.9+`, dentro de los rangos aceptados por
  el runtime.
- La URL de conexión generada al crear/configurar el agente en Query.

## Instalación local

En PowerShell:

```powershell
cd "C:\Users\julia\Repos\- Query-assets\query-agent-plugin"
npm install
npm run build
openclaw plugins install -l "C:\Users\julia\Repos\- Query-assets\query-agent-plugin"
openclaw plugins enable query
```

La opción `-l` enlaza esta carpeta; después de modificar el código basta con
ejecutar `npm run build` y reiniciar el Gateway.

## Configuración

Query entrega una URL parecida a esta al revelar las instrucciones del bot:

```text
wss://api.example.com/ws/openclaw-agent/42/?token=SECRETO
```

La forma más directa es guardar esa URL completa:

```powershell
openclaw config set channels.query.url 'wss://api.example.com/ws/openclaw-agent/42/?token=SECRETO'
openclaw config set channels.query.enabled true
openclaw gateway restart
```

También se puede separar el secreto para que no quede dentro de la URL:

```json5
{
  channels: {
    query: {
      enabled: true,
      url: "wss://api.example.com/ws/openclaw-agent/42/",
      token: "SECRETO",
      heartbeatMs: 25000,
      reconnectMinMs: 500,
      reconnectMaxMs: 15000,
      activityMode: "smart",
      effortMode: "auto",
    },
  },
}
```

Si no se configura `channels.query.token`, el plugin intenta
`QUERY_OPENCLAW_TOKEN` y, finalmente, el parámetro `token` de la URL. Nunca
escribe el token en sus logs.

Para dirigir este canal a un agente distinto del predeterminado se usa el
sistema normal de bindings del runtime, con `channel: "query"` y
`accountId: "default"`.

### Multiples agentes Query

Para conectar varios bots Query a varios agentes OpenClaw en el mismo gateway,
usa `channels.query.accounts`. Cada cuenta mantiene su propio WebSocket,
reconexion, cache durable por `client_msg_id` y estado.

```json5
{
  channels: {
    query: {
      enabled: true,
      accounts: {
        query: {
          url: "wss://apius.itsquery.com/ws/openclaw-agent/3/?token=SECRETO",
          origin: "https://us.itsquery.com",
          stateFile: "/home/ubuntu/.openclaw/workspace/tenants/query/state/query-plugin-response-cache.json",
        },
        "director-asocapitales": {
          url: "wss://apiasocapitales.itsquery.com/ws/openclaw-agent/1/?token=SECRETO",
          origin: "https://us.itsquery.com",
          stateFile: "/home/ubuntu/.openclaw/workspace/tenants/asocapitales/state/query-plugin-response-cache.json",
        },
      },
    },
  },
  bindings: [
    {
      type: "route",
      agentId: "query",
      match: { channel: "query", accountId: "query" },
    },
    {
      type: "route",
      agentId: "director",
      match: { channel: "query", accountId: "director-asocapitales" },
    },
  ],
}
```

El bloque de configuracion que entrega Query describe el contrato WebSocket.
Para OpenClaw, los campos importantes son:

- `connection.url`: va en `channels.query.url` si hay una sola cuenta, o en
  `channels.query.accounts.<accountId>.url` si hay varios agentes.
- `identity.agent`: va en el binding `agentId`.
- `identity.name`: sirve como nombre humano; no enruta por si solo.
- `protocol`: es informativo; Query no negocia `Sec-WebSocket-Protocol`.

### Canales y privacidad (protocolo v2)

Una cuenta Query mantiene un solo WebSocket por agente, pero puede transportar
muchos canales. El plugin usa `thread_id` como clave de sesión y de
idempotencia:

- `general`: contexto compartido por quienes tienen acceso al agente;
- `topic`: contexto compartido por los miembros autorizados del canal;
- `private`: contexto exclusivo del usuario dueño y del soporte visible que
  haya entrado explícitamente.

Cada evento entrante debe incluir `thread_id`; cada actividad y respuesta lo
devuelve junto con `client_msg_id`. El plugin nunca cae silenciosamente al canal
General si no reconoce el hilo. El protocolo v1 continúa aceptándose durante el
despliegue, pero no ofrece aislamiento multihilo.

Query conserva la fuente de verdad de permisos, historial, autoría y
notificaciones. El plugin recibe el autor real y el tipo/nombre del canal para
construir el turno del agente, pero no decide quién puede leer o escribir.

### Tareas programadas

Los cambios del servicio cron de OpenClaw se sincronizan con Query mediante
`schedule.sync`. Query materializa una entrega por usuario/hilo y puede enviar
`schedule.cancel` cuando se revoca el acceso de su último destinatario.

Las tareas personales creadas desde un canal compartido deben dirigirse al
`private_thread_id` del solicitante. Una cancelación queda registrada en Query
y se reenvía si el plugin estaba desconectado.

### Cuentas de Google por persona

Las herramientas `google_*` no se ejecutan en una sesión de Query hasta que
Query confirma que esa cuenta es de quien está conversando. El guard corre en
`before_tool_call`, antes de que exista un cliente de Google, y bloquea cuando:

- la llamada no dice explícitamente qué `accountId` usa (no hay cuenta por
  defecto, ni siquiera con una sola configurada);
- no hay credencial delegada vigente para el canal —incluido el caso de un cron
  cuya tarea no tiene un autor con acceso vigente;
- Query responde que esa cuenta no es de esa persona, está pendiente de revisión
  o fue revocada;
- no se puede consultar a Query (un fallo de red no abre el paso).

`QUERY_EXTERNAL_ACCOUNT_GUARD_TOOLS=gmail,gcal` amplía los prefijos vigilados.

El mensaje de bloqueo le dice al agente qué cuentas sí tiene esa persona, así que
el reintento suele ser el correcto. La identidad sale de la credencial que firmó
Query, no del prompt: el agente puede equivocarse de nombre sin que el error
llegue a Google. Un subagente lanzado desde un turno de Query hereda el canal, y
con él la misma restricción.

Query devuelve además el correo con el que espera que esa cuenta esté
autenticada. El guard lo usa para preguntar y para contrastar lo que la llamada
ya traiga —si no coincide, bloquea aunque la cuenta sí sea de esa persona— pero
**no reescribe los parámetros de la tool**: hoy las herramientas de
`openclaw-google-workspace` sólo reciben `accountId`, y el correo esperado vive
en la configuración interna de cada cuenta de ese plugin, que lo valida por su
lado. `QUERY_GOOGLE_GUARD_EXPECTED_EMAIL_PARAM` existe por si ese contrato
cambia; déjalo apagado.

#### Reconocer en el primer uso una cuenta que ya estaba configurada

Las cuentas de Google se configuraron en OpenClaw antes de que Query llevara la
tabla de vínculos, así que la primera vez que alguien usa la suya desde Query no
hay nada vinculado y la respuesta sería 403. Pedir una migración manual por
persona convierte el aislamiento en un trámite, y un trámite que estorba se
termina saltando por lo ancho.

Antes de preguntar, el guard busca en la configuración local de Google Workspace
el `expectedEmail` de ese `accountId` y lo manda a Query en `configured_email`.
Si coincide exactamente con el correo del usuario que firmó el token, Query crea
el vínculo `verified` en ese momento y deja pasar. Si no coincide, no autoriza y
no crea nada.

Los dos correos que viajan al backend **no valen lo mismo**, y por eso van en
campos distintos:

| campo | de dónde sale | qué puede hacer |
| --- | --- | --- |
| `configured_email` | `expectedEmail` en la config de la máquina | fundar el vínculo la primera vez |
| `authenticated_email` | parámetros de la tool, o sea el modelo | sólo bloquear si no cuadra |

El modelo elige el `accountId` y puede escribir el correo que quiera en los
parámetros; lo que no puede es editar la configuración de la máquina. Esa es la
única razón por la que `configured_email` sirve como prueba.

El atajo no se aplica cuando la cuenta ya tiene una decisión tomada: si está
vinculada a otra persona, revocada, o esperando revisión, sigue bloqueada. Y si
la cuenta local se reconfigura a otro buzón, el guard lo delata —Query responde
`email_mismatch` en vez de seguir apuntando a donde ya no apunta.

Esto **no reemplaza la verificación de Google**. Después de que Query autorice,
`openclaw-google-workspace` sigue comprobando que el token OAuth real pertenece
al `expectedEmail` configurado; si el token es de otro correo, la tool falla
igual.

El dato se lee de:

```
plugins.entries["openclaw-google-workspace"].config.accounts[accountId].expectedEmail
```

`plugins.entries` es un objeto indexado por id de plugin y `accounts` un mapa por
`accountId` — ésa es la forma que hay en la máquina. El lector también acepta
`plugins.entries` como lista y `accounts` como lista, además de algunos alias del
nombre del correo, porque ese formato lo fija `openclaw-google-workspace` y puede
cambiarlo sin avisar: si dejara de reconocerse, el fallo sería mudo —todo el
mundo bloqueado sin un error que lo explique—. Si esa versión guarda las cuentas
en otro sitio, hay dos escapes sin tocar código:

- `QUERY_GOOGLE_WORKSPACE_PLUGIN_IDS=mi-plugin-google` — id exacto de la entrada
  en `plugins.entries` cuando el nombre no contiene "google workspace".
- `QUERY_GOOGLE_WORKSPACE_ACCOUNTS_FILE=/ruta/accounts.json` — archivo aparte con
  las cuentas, leído con las mismas reglas.

Si no se encuentra correo, no se manda nada y todo se comporta como antes: sin
vínculo previo, 403.

El patrón `google_*` cubre las herramientas actuales —`google_gmail_*`,
`google_calendar_*`, `google_drive_*`, `google_tasks_*`, `google_sheets_*`,
`google_contacts_*`, `google_workspace_*`— incluidas las de autenticación, que
también quedan protegidas en sesiones Query: la migración de cuentas se hace por
admin y auditoría, no por lo que el agente decida en un turno.
`QUERY_EXTERNAL_ACCOUNT_GUARD_TOOLS` sólo hace falta si aparece una herramienta
con otro prefijo.

## Verificación

```powershell
openclaw plugins inspect query --runtime --json
openclaw channels status --probe
openclaw logs --follow
```

Al enviar `hola` desde React o Flutter, el flujo esperado es:

```text
Query REST/WS -> plugin: message(client_msg_id)
plugin -> Query: activity(state=working)       inmediato
plugin -> OpenClaw: turno del agente
plugin -> Query: activity/tool/heartbeat       mientras sigue trabajando
plugin -> Query: message(client_msg_id)        respuesta terminal
```

En los logs debe aparecer `connected to Query`. Si el socket cae, el plugin se
reconecta con espera exponencial de 0.5 a 15 segundos. Además envía un ping cada
25 segundos, por debajo del cierre inactivo típico de 60 segundos de Nginx.

## Confiabilidad

- Cada respuesta conserva el `client_msg_id` original.
- Un mensaje duplicado recibe la respuesta ya calculada, sin volver a ejecutar
  al agente.
- Las últimas 2.000 respuestas por `thread_id + client_msg_id` se guardan
  durante hasta 30 días en
  `<OPENCLAW_STATE_DIR>/query-channel/default/responses.json`.
- El archivo se escribe de forma atómica y con permisos restringidos.
- `responseTimeoutMs` vale `0` de forma predeterminada (sin timeout artificial).
- El plugin envía estados operativos seguros y un heartbeat de actividad cada
  20 segundos. Puede ajustarse con `QUERY_ACTIVITY_HEARTBEAT_MS` (mínimo 5000).
- No se expone el stream privado de pensamiento. Sí se transporta el comentario
  público que el propio agente escribe antes de una tarea o herramienta.

### Actividad visible

`channels.query.activityMode` decide cuánto ve la persona mientras el agente
trabaja. Si no se configura se usa `QUERY_AGENT_ACTIVITY_MODE` y, en último
lugar, `smart`.

| Modo | Qué muestra |
| --- | --- |
| `off` | Nada. El latido sigue saliendo marcado como interno para que Query sepa que el turno vive. |
| `lite` | Acuse de recibo; si pasan 4 s, también el último comentario público concreto del agente. |
| `smart` | Bitácora pública inmediata: comentarios, planes y ciclos de herramientas, sin descartar pasos por tiempo. |
| `verbose` | La misma bitácora completa y además los pasos de mantenimiento marcados `admin`. |
| `debug-internal` | Todo, incluido lo marcado `internal`. Solo para el panel interno. |

Cada evento viaja con `kind` (paso canónico), `run_id`, `sequence`, `source` y
`visibility` (`public` / `admin` / `internal`). Query filtra por `visibility` antes de
reenviar al chat, así que un paso `admin` llega al panel pero no a la persona.
La secuencia permite que Query persista reintentos de forma idempotente sin
confundir dos pasos iguales que sí ocurrieron en momentos distintos.

Los estados operativos salen de un catálogo fijo en `src/activity-policy.ts` y
no requieren una segunda llamada al modelo. El evento público
`commentary/preamble` conserva la frase real del agente —por ejemplo, qué va a
contrastar o validar—, pero pasa por el mismo saneador que descarta
credenciales, rutas del servidor, trazas, prompts y payloads crudos. Los eventos
privados `thinking/reasoning` nunca se reenvían.

### Esfuerzo por turno

`channels.query.effortMode` (o `QUERY_AGENT_EFFORT_MODE`) acepta `fast`,
`normal`, `careful`, `exhaustive` y `auto`. Query Core puede enviar un override
por agente en `data.effort_mode`; ese valor manda para el turno actual y evita
tener que reiniciar el gateway al editar un agente.

`auto` es el valor predeterminado. El router es determinista y no llama a otro
LLM: saludos y preguntas simples parten en `fast`, una consulta ordinaria en
`normal`, escrituras/finanzas/comunicaciones/configuración suben como mínimo a
`careful`, y auditorías, cierres, migraciones o producción suben a
`exhaustive`. Pedir "hazlo rápido" nunca reduce ese piso de seguridad.

Cada actividad incluye solamente enums saneados:
`effort_mode_configured`, `effort_mode_effective`, `effort_escalated` y
`effort_escalation_reason`. Los logs de fin de turno agregan esos campos,
latencia total, cantidad de herramientas y tamaño aproximado del contexto.

`QUERY_TOOLS_CACHE_TTL_MS` (60000 por omisión, `0` desactiva) controla cuánto
se reutiliza la metadata de módulos entre llamadas de una misma credencial.
- Los adjuntos entrantes se entregan al contexto multimedia del agente; las
  URLs multimedia devueltas por el agente regresan como adjuntos de Query.

### Entrega obligatoria de archivos

Cada turno del canal Query recibe una directiva central que exige entregar los
archivos generados mediante attachments/assets y prohÃ­be presentar rutas del
workspace, localhost, redes privadas o Tailscale como resultado final. La regla
vive en `src/inbound.ts`: aplica desde el primer mensaje de cualquier agente y
no depende de `AGENTS.md` ni `TOOLS.md`. Los `LocalPath` de adjuntos entrantes
siguen disponibles para que el agente pueda leerlos.

La tool `query_attachment_send` recibe `file_path` y opcionalmente `thread_id`,
`message`, `name`, `mime_type` y `kind`. Reutiliza `uploadArtifactToQuery()` con
la credencial delegada, devuelve la URL opaca de Query y publica media
estructurada para que OpenClaw la incorpore a `mediaUrls`; el socket la entrega
finalmente en `data.attachments`. En outbound y cron se usa el mismo uploader
con la credencial del bot mediante `uploadOutboundArtifactToQuery()`.

Como defensa final, `src/private-links.ts` reescribe rutas Linux/Windows, hosts
privados y URLs fabricadas con rutas locales. Si el archivo no existe, falta
credencial o falla la subida, elimina la referencia insegura, conserva una
explicaciÃ³n visible y registra solo un cÃ³digo seguro del error.

### Artifacts editables

`uploadArtifactToQuery()` y `uploadOutboundArtifactToQuery()` aceptan el campo
opcional `replaceAttachmentId`. Al enviarlo usan `PUT` y reemplazan el blob del
adjunto conservando su ID; al omitirlo mantienen el `POST` de creación.

**Reemplazar es el comportamiento por defecto.** El canal recuerda, por hilo y
ruta local, qué asset salió de cada archivo (`src/artifact-store.ts`,
persistido en `<OPENCLAW_STATE_DIR>/query-artifacts.json`). Reenviar el mismo
archivo reemplaza su contenido: la URL pública no cambia, así que el enlace que
la persona ya tiene sigue sirviendo y muestra la versión al día. Sin esto, una
tarde de correcciones dejaba diez copias y nueve enlaces obsoletos.

Conservar la versión anterior es una decisión explícita, no un accidente: el
agente llama a `query_artifact_new_version` con la ruta antes de reenviar, y ese
envío crea un asset nuevo dejando el anterior intacto.

Dos salvaguardas: un asset **fijado** (`pinned`) no se reemplaza nunca —es un
template o algo ya publicado, y Query no lo impide del lado del servidor, así
que la regla vive aquí—, y si Query rechaza el reemplazo se olvida la ruta y se
sube como nuevo, que es peor que reutilizarlo pero mucho mejor que perder el
archivo.

`QUERY_ARTIFACT_REUSE_TTL_MS` permite caducar el reuso (0 = sin límite, el
valor por defecto).

Para templates u otros artifacts permanentes se puede pasar `pinned: true` al
crear o reemplazar. Query responderá `is_pinned: true` y `expires_at: null`, y
el asset quedará excluido de la limpieza automática. Para cambiar
un asset existente sin volver a subir su archivo están disponibles
`setQueryArtifactPinned()` y `setOutboundQueryArtifactPinned()`.

## Desarrollo

```powershell
npm run check
npm test
npm run build
npm pack
```

Las pruebas levantan un servidor WebSocket real y comprueban el ACK inmediato,
la respuesta correlacionada, la persistencia y la deduplicación de reintentos.
