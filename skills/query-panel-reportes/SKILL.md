---
name: query-panel-reportes
description: 'Diseño de HTML con datos de Query y reportes o dashboards en vivo fijados al menú de Query. Leer junto con query-panel antes de crear o publicar cualquier HTML, reporte o dashboard.'
---

# query-panel-reportes

Anexo temático de `query-panel`. Las reglas generales de `query-panel` (guardrails, permisos, propuestas, credenciales) siguen aplicando; si no las has cargado en este turno, léelas primero con `skills_read` (name: `query-panel`).

## Diseno de todo HTML con datos

Vale para reportes, dashboards fijables y dashboards en vivo, sobre todo si se
hacen desde cero y no hay un tablero de referencia.

**Es el estilo por defecto, no una imposicion.** Si la persona manda un
referente (imagen, HTML, enlace, plantilla, manual de marca) o pide un estilo,
ese manda: colores, tipografia, estructura, densidad, margenes y si lleva
graficas o no. De esta guia solo se mantiene lo que no es estetico: que todo
texto sea legible, que un error no se vea como "sin datos" y, en el en vivo,
las reglas tecnicas de datos. Si el referente es ambiguo, pregunta una vez.

1. **Estructura:** titulo con el periodo, fila de KPIs (con variacion frente
   al periodo anterior cuando aplique), al menos una grafica analitica y
   despues el detalle en tabla.
2. **Grafica obligatoria, nunca solo tablas.** Elige la que muestre algo que la
   tabla no muestra:
   - tiempo: linea o area (tendencia);
   - ranking: barras horizontales ordenadas;
   - proporcion con pocas categorias: dona;
   - dos dimensiones (persona x semana): barras apiladas o mapa de calor;
   - meta contra real: barras con linea de meta.

   Acompanala de una frase de hallazgo: que crece o cae, quien concentra, que
   cambio frente al periodo anterior. Chart.js o ECharts desde
   cdnjs.cloudflare.com o cdn.jsdelivr.net.
3. **Contraste:** fondo oscuro, texto claro; fondo claro, texto oscuro,
   tambien en titulos, etiquetas, leyendas y ejes. Una paleta coherente con el
   fondo.
4. **Controles:** si hay fecha, selector de periodo (este mes por defecto, mes
   anterior, ultimos 7 y 30 dias, trimestre, ano, personalizado); filtros con
   desplegables estilizados para persona, estado o categoria, con opciones de
   los datos. Nunca el estilo por defecto del navegador. En un reporte, los
   filtros trabajan sobre los datos que el HTML ya trae; en el en vivo, con
   `QueryDashboard.dateRange` y `QueryDashboard.select`.
5. **Margenes:** nada pegado a los bordes (padding de 24px, contenido centrado
   con ancho maximo cerca de 1400px) y aire entre tarjetas.
6. **Estados:** cargando, error y vacio, distintos.

Al publicar un dashboard, si la respuesta trae `design_hints` (sin grafica, sin
control de periodo), corrigelos en el mismo turno con una version nueva, salvo
que contradigan el referente o el estilo que pidio la persona.

## Reportes y dashboards en vivo

Un HTML con datos se entrega de una de dos formas. Elegir bien evita trabajo:
el dashboard en vivo cuesta mas y solo vale la pena si alguien lo va a volver
a abrir.

**Regla:** por defecto, **reporte**. Solo **dashboard en vivo** si alguien va
a volver a abrirlo en otro momento esperando ver los datos de ese momento.

| La persona pide o dice | Entrega |
|---|---|
| Fijarlo, ponerlo en el menu, compartirlo con un rol o usuario | Dashboard en vivo |
| "Seguimiento", "tablero", "monitorear", "cada dia/semana", "siempre actualizado", "en tiempo real" | Dashboard en vivo |
| Convertir un reporte que ya existe | Dashboard en vivo |
| Pregunta puntual o exploracion: "muestrame", "como vamos", "comparame" | Reporte |
| Periodo cerrado ("septiembre", "2025"): esos datos ya no cambian | Reporte |
| Para enviar, descargar o presentar | Reporte |
| Datos de la web consultados ahora | Reporte |
| Fijar algo cuyos datos vienen de Google Sheets, una API u otra fuente que no es Query | Dashboard fijable sin queries |
| Duda | Reporte |

No preguntes antes de elegir. Si entregas un reporte de algo que parece
recurrente, cierra con una linea: "Si quieres tenerlo en tu menu con datos al
dia, lo convierto en dashboard en vivo."

Si la persona pide comparar las dos formas, entrega ambas con la misma
informacion y el mismo diseno: el reporte con `query_attachment_send` y el
dashboard en vivo con `query_dashboard_publish`. Senala en una linea que el
reporte es una foto del momento y el dashboard consulta al abrirse.

**Reporte:** genera el HTML con los datos dentro y publicalo con
`query_attachment_send`.

**Dashboard en vivo:** `query_dashboard_publish` con `queries`. El HTML no
lleva datos; los pide por nombre al abrirse y Query los consulta con los
permisos del autor.

**Dashboard fijable sin queries:** `query_dashboard_publish` sin `queries`. El
HTML trae sus datos o los pide desde el navegador a una fuente publica por
HTTPS (Google Sheets publicado como CSV, una API con CORS). No usa
`QueryDashboard`; muestra su propio estado de carga y de error. Se fija y se
comparte igual que uno en vivo.

1. Descubre modulos y campos, y prueba cada consulta con
   `query_records_aggregate` o `query_records_search` antes de publicar.
2. Declara las consultas con nombre. Usa fechas relativas (`{{start_of_month}}`,
   `{{today}}`, `{{days_ago_30}}`...) para "este mes", "ultimos 30 dias", etc.
3. Disena con la misma libertad que un reporte: tu propio CSS, layout,
   graficas (Chart.js, ECharts), pestanas, filtros y calculos en JavaScript.
   Debe verse tan completo como el reporte equivalente, no solo una tabla. Lo
   unico distinto es que los datos se leen con `QueryDashboard.render`, que
   corre al abrir y en cada Actualizar. Query pone encima el titulo y el boton
   Actualizar: no los repitas. Las clases `qd-*` son un atajo opcional que ya
   combina con el tema de la app.
4. Separa siempre tres estados: cargando, error y vacio.
   `QueryDashboard.rows(r)` devuelve `[]` tambien cuando la consulta fallo, asi
   que antes pregunta `QueryDashboard.state(r)`: `"error"` (muestra `qd-error`
   con `r.detail`), `"empty"` (`qd-empty`) u `"ok"`. Un error nunca se pinta
   como "no hay datos".
5. Si Query responde `dashboard_invalid`, lee `errors` (consulta que falla,
   consulta sin usar, error y vacio sin distinguir, valores copiados en el HTML)
   y corrige todo de una vez.
6. Si la persona pidio fijarlo o compartirlo, llama `query_dashboard_share` en
   el mismo turno. Su instruccion es la autorizacion; no pidas otra.
7. Reglas visuales: contraste siempre (fondo oscuro, texto claro; fondo
   claro, texto oscuro), tambien en titulos y etiquetas; una paleta coherente
   con el fondo; ningun control con el estilo por defecto del navegador.
   Query muestra el cargador y corrige texto ilegible, pero no confies en eso.
8. Controles: si hay fecha, siempre un periodo con
   `QueryDashboard.dateRange('#periodo', {from: 'desde', to: 'hasta'})` y
   controls `desde`/`hasta` de tipo `date` con default `{{start_of_month}}` y
   `{{end_of_month}}`; las consultas usan `{{desde}}` y `{{hasta}}`. Para
   persona, estado o categoria, `QueryDashboard.select(...)` con las opciones
   reales de los datos. Todos juntos en un `div.qd-controls` arriba.
9. Rendimiento: filtra por el periodo, prefiere agregados, `limit` chico en
   listas. Si la respuesta dice que una consulta tarda mas de 2000 ms
   (`elapsed_ms`) o recorre miles de registros (`records_scanned`), agregale
   filtros o dividela.
10. Que Query responda `ok` no prueba lo que la persona ve. No digas
   "corregido" ni "ya esta en tu menu" como hecho comprobado: di que quedo
   publicado o fijado y pidele que lo abra desde el menu Dashboards o el
   adjunto y te confirme que ve los datos.

```json
[
  {"name": "ventas_mes", "source": "records_aggregate", "module": "ventas",
   "metrics": [{"operation": "sum", "field": "valor", "alias": "total"}],
   "group_by": ["fecha"], "time_granularity": {"fecha": "day"},
   "date_filters": [{"field": "fecha", "from": "{{desde}}", "to": "{{hasta}}"}]},
  {"name": "meta_mes", "source": "static", "value": 120000000}
]
```

Controls de ese ejemplo:

```json
[
  {"slug": "desde", "label": "Desde", "type": "date", "default": "{{start_of_month}}"},
  {"slug": "hasta", "label": "Hasta", "type": "date", "default": "{{end_of_month}}"}
]
```

```html
<div class="qd-page">
  <div class="qd-controls"><div id="periodo"></div></div>
  <div class="qd-grid qd-cols-2">
    <div class="qd-card qd-kpi">
      <span class="qd-kpi-label">Ventas del mes</span>
      <span class="qd-kpi-value" id="total">—</span>
    </div>
    <div class="qd-card qd-kpi">
      <span class="qd-kpi-label">Meta</span>
      <span class="qd-kpi-value" id="meta">—</span>
    </div>
  </div>
</div>
<script>
QueryDashboard.dateRange("#periodo", { from: "desde", to: "hasta" });
QueryDashboard.render(function (data) {
  var ventas = data.ventas_mes;
  var estado = QueryDashboard.state(ventas);
  var total = document.getElementById("total");
  if (estado === "error") {
    total.innerHTML = '<span class="qd-error">No se pudo consultar: ' + (ventas.detail || "error") + "</span>";
  } else if (estado === "empty") {
    total.innerHTML = '<span class="qd-empty">Sin ventas este mes</span>';
  } else {
    var suma = QueryDashboard.rows(ventas).reduce(function (s, f) { return s + (f.total || 0); }, 0);
    total.textContent = QueryDashboard.format.currency(suma);
  }
  document.getElementById("meta").textContent = QueryDashboard.format.currency(data.meta_mes.value);
});
</script>
```

Quien ve un dashboard:

- Recien publicado solo lo ve su autor y no esta fijado.
- "Fijalo" sin decir para quien: fijalo solo para la persona y ofrece
  compartirlo.
- "Compartelo con Cobranza y con Ana": `query_dashboard_share` con
  `groups: ["Cobranza"]`, `users: ["Ana"]`. Si vuelve `audience_unresolved`
  no se aplico nada: muestra los candidatos y pregunta.
- Al confirmar, di quien lo ve (campo `audience`) y que lo ven con los permisos
  del autor, aunque no tengan acceso a esos modulos.
- Para cambiar un dashboard existente, busca su id con `query_dashboards_list`
  y publica una version nueva con `dashboard_id`: conserva id, nombre, fijado y
  audiencia. No crees otro dashboard para corregir uno que ya existe.
- Para quitar uno que ya no sirve: `query_dashboard_share` con `pinned: false`
  lo saca del menu; con `active: false` lo archiva (nadie mas lo ve, se puede
  reactivar); `query_dashboard_delete` lo borra del todo y solo si la persona
  pide borrarlo.

