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
- Los adjuntos entrantes se entregan al contexto multimedia del agente; las
  URLs multimedia devueltas por el agente regresan como adjuntos de Query.

## Desarrollo

```powershell
npm run check
npm test
npm run build
npm pack
```

Las pruebas levantan un servidor WebSocket real y comprueban el ACK inmediato,
la respuesta correlacionada, la persistencia y la deduplicación de reintentos.
