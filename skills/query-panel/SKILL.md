---
name: query-panel
description: 'Read and change Query panel data on behalf of the person you are chatting with, using their own permissions. Use whenever someone asks what exists in their system, what a module is about, which fields it has, asks to find or open records, or asks to create or modify a record. Every write goes through a proposal that a human confirms; never write to Query by any other route. Discovery-first: never assume module or field names.'
---

# Query Panel Reader

Cada sistema Query es distinto: sus modulos, campos y grupos los configura cada
organizacion. No hay una lista fija que puedas dar por sabida. Antes de
responder nada sobre datos, **mapea la configuracion viva del sistema**.

Las consultas viajan con la credencial de la persona con la que conversas, asi
que lo que ves es exactamente lo que ella ve. No es tu acceso: es el suyo.

## Guardrails

- Descubre siempre antes de afirmar: modulos, campos y grupos con llamadas
  reales, nunca de memoria ni de otra conversacion.
- Nunca inventes un nombre de modulo, un slug de campo ni un valor de estado.
  Si no aparecio en una respuesta de estas herramientas, no existe.
- No reutilices ids, slugs ni resultados de otro sistema ni de otro canal.
- Nunca pidas, muestres ni repitas credenciales: el plugin las pone por ti.
- Si una consulta vuelve vacia, distingue "no hay registros" de "filtre por un
  campo que no existe". Comprueba el campo antes de concluir.
- Lo que no puedas ver, dilo como lo que es: falta de permisos de esa persona,
  no ausencia de datos.

## Flujo de lectura

1. `query_modules_list` — que modulos existen en **este** sistema y cuales puede
   ver esta persona.
2. `query_module_describe` — de que trata el modulo: sus grupos de campos, los
   campos de cada grupo, sus tipos, cuales son obligatorios, cuales son de solo
   lectura y que opciones exactas admite cada campo de seleccion. En campos
   `status`, si una opcion viene como `Etiqueta|color`, usa solo `Etiqueta` al
   proponer valores; el sufijo despues de `|` es metadata visual del estado.
   Cada campo trae tambien su `id` interno -no el `slug`- que es lo que
   necesitas para corregirlo despues con `query_api_plan_propose`.
3. `query_records_search` — busca con los slugs reales y, cuando haya mas de
   un criterio, usa `filters`. Pide solo las `columns` necesarias para no llenar
   el contexto con campos que no vas a usar. `author` es el campo del sistema
   para quien creo el registro y acepta username o nombre completo.
4. `query_records_aggregate` — para horas, dinero, conteos, promedios o
   reportes, filtra y calcula en Query. No descargues decenas de filas para
   sumarlas manualmente. Puede agrupar por fecha, autor u otro campo real.
5. `query_record_get` — abre un registro concreto cuando necesites todo su
   detalle.

Los pasos 1 y 2 son los que te permiten *entender* el sistema. Saltartelos es la
causa habitual de responder con seguridad algo que no es cierto.

## Entender de que trata un modulo

`query_module_describe` no es solo una lista de campos: es la descripcion del
proceso que ese modulo modela. Leelo asi:

- Los **grupos de campos** cuentan las etapas o secciones del proceso.
- Los **tipos** dicen la naturaleza del dato (fecha, estado, relacion, calculo).
- Los campos de **estado** y sus opciones son el ciclo de vida del registro.
- Los campos **relacionales** dicen con que otros modulos se conecta, y por ahi
  se entiende el mapa del sistema.
- Los campos **obligatorios** revelan que es imprescindible en ese proceso.

Con eso puedes explicar en palabras normales para que sirve un modulo, aunque
sea la primera vez que lo ves.

## Parametros

Todas las herramientas piden `thread_id`: es el id del canal de Query en el que
estas conversando (`conversation.id`). Va siempre tal cual; no lo inventes ni lo
tomes de otra conversacion.

## Si te dicen que no hay credencial vigente

El permiso que Query concede para consultar caduca a los 15 minutos. Si una
herramienta responde `no_credential`, pide a la persona que te escriba un
mensaje nuevo en ese canal y reintenta. No busques otra via ni pidas tokens.

## Cuando lo que corre es una tarea programada

Un cron no tiene a nadie escribiendo, asi que no puede seguir el consejo de
arriba: pedir "escribeme un mensaje" a las 8 de la manana no sirve de nada. Su
credencial se pide sola al arrancar el turno y corre con los permisos de **quien
creo la tarea**, no con los de quien haya escrito de ultimo en el canal.

Si aun asi una consulta responde `no_credential`, la tarea se registro sin autor
comprobable. No lo intentes por otra via: dilo en el reporte y pide que vuelvan
a crearla desde una conversacion con la persona en cuyo nombre debe correr.

## Cambiar datos: siempre propuesta, nunca ejecucion

`query_record_propose` es la **unica** via para tocar datos de Query. Sirve
tanto para crear como para actualizar, y no aplica nada: deja la propuesta en el
chat y una persona la confirma con un boton.

No uses propuestas de registros para **entregar archivos generados**. Si creaste
un HTML, PDF, imagen, hoja de calculo, demo, reporte visual o cualquier artifact
local, eso no es un registro de negocio: publicalo en el canal actual con
`query_attachment_send`, usando la ruta local solo como `file_path` interno y
sin mostrarla a la persona. Si la herramienta no esta cargada, localizala y
cargala primero con `tool_search`; no afirmes que no esta disponible antes de
buscarla. Nunca crees un registro solo para mandar un link o una ruta local del
archivo generado.

Nunca escribas en Query por otro camino, aunque dispongas de otra herramienta,
otro token o la API general. Si crees que hace falta escribir de otra forma,
dilo y detente.

Flujo:

1. `query_module_describe` — consigue los slugs reales y los valores exactos que
   admite cada campo. Un slug inventado hace fallar la propuesta entera. En
   campos `status`, si la opcion aparece como `Etiqueta|color`, propone solo
   `Etiqueta`; el color no debe guardarse como valor del registro.
2. `query_records_search` o `query_record_get` — si vas a actualizar, mira antes
   como esta el registro. Para llenar un campo relacional `ref_*`, busca tambien
   el registro relacionado y usa `{"id": ...}`; si solo conoces el consecutivo,
   usa `{"consecutivo": ...}`. No inventes `label`, `type`, `module` ni
   `module_name`, porque Query construye y valida ese objeto.
3. `query_record_propose` — con `record_id` para actualizar, sin el para crear.
   Incluye `intent`: una frase que explique por que, porque la lee la persona
   que decide.
4. Avisa que la propuesta quedo en el chat esperando aprobacion.

### Configurar el panel (modulos, campos, carpetas)

Crear o modificar **la estructura** del panel no se hace con
`query_record_propose`, que es para datos de registros. Se hace con
`query_api_plan_propose`, que propone una secuencia de llamadas a la API.

Sigue siendo auditado: no se ejecuta nada hasta que una persona apruebe el
plan completo. Y quien apruebe tiene que ser **administrador**.

```json
{
  "thread_id": "conversation-id",
  "steps": [
    {
      "method": "POST",
      "path": "/api/v2/modulos/",
      "body": { "name": "obras", "label": "Obras", "description": "..." },
      "label": "Crear el modulo Obras"
    },
    {
      "method": "POST",
      "path": "/api/v2/custom-fields/",
      "body": {
        "module": "$0.id",
        "label": "Estado",
        "slug": "estado",
        "field_type": "status",
        "rol_sign": [],
        "edit_roles": []
      },
      "label": "Crear el campo Estado"
    }
  ],
  "intent": "Dejar listo el panel de obras"
}
```

Claves:

- **`"$N.campo"` encadena pasos.** El modulo no existe cuando propones, asi que
  el campo del paso 1 se cuelga de `"$0.id"`: el id que devolvera el paso 0.
- **`label` es lo que lee quien aprueba.** Sin el solo ve una ruta. Escribelo
  siempre y en lenguaje humano.
- **Todo o nada.** Si un paso falla, ninguno queda aplicado y te dice cual fue.
- **Maximo 40 pasos.**
- **Rutas bloqueadas:** usuarios, roles, permisos, tokens, agentes y las
  propias propuestas. El plan entero se rechaza si incluyes una. No insistas
  por otra via: dilo y detente.
- Antes de proponer, usa `query_module_describe` o consulta la estructura para
  no inventar slugs ni campos obligatorios.
- **`POST /api/v2/custom-fields/` siempre exige `field_type`, `rol_sign` y
  `edit_roles`**, aunque no vayas a restringir el campo por rol: manda
  `"rol_sign": []` y `"edit_roles": []` cuando no aplique. Olvidarlos es el
  motivo mas comun de que un paso de creacion de campo se rechace.
- **El cuerpo de cada paso se comprueba contra el endpoint real al proponer**,
  no solo su forma general. Un paso sin `"$N.campo"` que ya es incompatible
  (un campo obligatorio que falta, un valor que no existe) se rechaza aqui
  mismo, con el error de ese campo. Un paso encadenado a un valor que aun no
  existe queda diferido hasta que se confirme el plan.
- **Corregir un campo ya creado** es un `PATCH /api/v2/custom-fields/<id>/`.
  Ese `id` no es el `slug`: es la clave interna que devuelve
  `query_module_describe` en cada campo (`fields[].id`). Nunca lo inventes ni
  lo confundas con el `slug`.

#### Campos de seleccion (dropdown, radio, checkbox, status)

`options` es texto separado por comas, no un array JSON: `"Abierto,Cerrado"`.
Un `field_type: "status"` ademas admite color por opcion con
`"Etiqueta|color"`: `"Abierto|green,Cerrado|red"`. Mandar un array JSON como
string (`'["Abierto","Cerrado"]'`) se guarda tal cual -Query no lo valida- y
el panel lo muestra roto, fragmentado por las comas internas del JSON.

#### Campos relacionales (relational, multiple_relational_select, checkbox_relational)

Un campo que apunta a otro modulo necesita las tres claves juntas; ninguna
sola alcanza y el serializer **no** las exige, asi que un plan con solo
`field_type: "relational"` se acepta y queda roto en silencio -el panel
muestra "Unsupported relation type" porque no sabe con que renderizarlo-:

- `field_type`: `"relational"` (o `"multiple_relational_select"` /
  `"checkbox_relational"` para selección múltiple).
- `relations_type`: `"module"` (registros o vistas), `"master"`, `"user"` o
  `"role"`. Nunca lo dejes vacio.
- `related_module`: el `id` del modulo destino (usa `query_modules_list` para
  conseguirlo; no inventes el id ni uses el nombre).

El `slug` que escribas se guarda con el prefijo `ref_` puesto automaticamente
si no lo trae ya (`estado` se guarda como `ref_estado`); no hace falta que lo
agregues tu, pero tampoco es un error si lo haces.

```json
{
  "method": "POST",
  "path": "/api/v2/custom-fields/",
  "body": {
    "module": "$0.id",
    "label": "Proyecto asociado",
    "slug": "proyecto_asociado",
    "field_type": "relational",
    "relations_type": "module",
    "related_module": 34,
    "rol_sign": [],
    "edit_roles": []
  },
  "label": "Crear el campo Proyecto asociado, relacionado con Proyectos"
}
```

### Sumar un modulo a una categoria (grupo de modulos)

Un modulo **no** lleva su categoria en su propio cuerpo: `POST /api/v2/modulos/`
no tiene un campo `group` ni nada parecido, y mandarlo no hace nada -el paso
puede incluso rechazarse por otra razon y dar la impresion de que fue por eso-.
La categoria se asocia **despues**, con un paso aparte, y es **aditiva**: suma
el modulo sin tocar los que la categoria ya tenia.

1. `query_module_categories_list` — la lista real de categorias con su `id`.
   Nunca inventes un id ni supongas que el nombre visible ("Productividad")
   sirve como valor: si la categoria que necesitas no aparece, dilo en vez de
   crearla a ciegas.
2. En el plan, el ultimo paso suma el modulo con `POST` a
   `/api/v2/modulos-category/<id>/add-module/` y body `{"module": "$0.id"}`
   (o el id fijo de la categoria si ya la creaste en un paso anterior del
   mismo plan).

```json
{
  "thread_id": "conversation-id",
  "steps": [
    {
      "method": "POST",
      "path": "/api/v2/modulos/",
      "body": { "name": "obras", "label": "Obras", "description": "..." },
      "label": "Crear el modulo Obras"
    },
    {
      "method": "POST",
      "path": "/api/v2/modulos-category/7/add-module/",
      "body": { "module": "$0.id" },
      "label": "Sumar Obras a la categoria Productividad"
    }
  ],
  "intent": "Crear el modulo Obras dentro de Productividad"
}
```

Para crear una categoria nueva (no sumarse a una que ya existe), el paso es
`POST /api/v2/modulos-category/` con `title`, `slug`, `description` y `type`;
`add-module` sigue siendo el paso que la conecta con un modulo despues.

### Varios cambios a la vez

Si vas a proponer **mas de un registro**, usa `query_records_propose_batch` en
lugar de llamar varias veces a `query_record_propose`.

No es una optimizacion tecnica: diez llamadas sueltas dejan diez tarjetas y
obligan a la persona a aprobar diez veces algo que para ella fue una sola
orden. Con el lote queda una tarjeta y una aprobacion.

```json
{
  "thread_id": "conversation-id",
  "module": "obras",
  "items": [
    { "record_id": 12, "fields": { "estado": "Cerrado" } },
    { "record_id": 15, "fields": { "estado": "Cerrado" } },
    { "title": "Obra nueva", "fields": { "estado": "Abierto" } }
  ],
  "intent": "Cerrar las obras entregadas y abrir la de marzo"
}
```

Reglas del lote:

- Todos los items van al **mismo modulo**. Si necesitas tocar dos modulos, son
  dos lotes.
- Cada item lleva `record_id` para actualizar, u omitelo para crear. Con
  `"delete": true` y su `record_id`, ese item **elimina** el registro.
- Un lote que borra exige que quien apruebe tenga permiso de **eliminar** en el
  modulo, se pinta en rojo y pide una confirmacion aparte que enumera lo que va
  a desaparecer.
- Maximo 50 items.
- **Si un item esta mal, Query rechaza el lote completo** y no queda ninguna
  tarjeta. Revisa los slugs con `query_module_describe` antes de enviarlo. La
  respuesta te dice el `index` de cada item con problema para que lo corrijas.
- Al confirmar se aplica **todo o nada**: si un registro cambio desde que
  propusiste, no se escribe ninguno y te lo informa.

### Eliminar un registro

Borrar es la unica operacion que no se puede deshacer, asi que va por su propia
herramienta: `query_record_delete_propose`. Tampoco borra nada por si sola —deja
la propuesta y una persona la confirma en un modal que le enumera que registro
desaparece— pero exige mas que las demas:

- Quien apruebe necesita permiso de **eliminar** en ese modulo, no el de editar.
  Miralo en `query_modules_list` (`permissions.delete`) antes de proponer.
- Ubica el registro con `query_records_search` o `query_record_get` y confirma
  que es el correcto. Un id equivocado aqui no tiene vuelta atras.
- Escribe siempre `intent` explicando por que se elimina: es lo que lee quien
  decide, y en un borrado es lo unico que justifica el clic.
- Si son varios registros del mismo modulo, usa `query_records_propose_batch`
  con `"delete": true` en cada item, para que sea una sola decision.

```json
{
  "thread_id": "conversation-id",
  "module": "obras",
  "record_id": 12,
  "intent": "Duplicado de la obra 15, cargado dos veces el 3 de marzo"
}
```

Nunca des por hecho el borrado en tu respuesta: di que la propuesta quedo en el
chat esperando aprobacion.

### Editar el titulo del registro

El titulo visible de un registro **no** es un campo dentro de `fields` ni una
llave de `json_data`. Viaja como parametro superior `title` en
`query_record_propose`.

Para renombrar un registro existente:

1. Usa `query_records_search` o `query_record_get` para ubicar el registro y
   confirmar su `record_id`.
2. Llama `query_record_propose` con `record_id` y `title`.
3. Si no vas a cambiar campos, puedes enviar `fields: {}` u omitir `fields`.
4. Incluye `intent`, por ejemplo: `Actualizar el titulo visible del registro`.

Ejemplo:

```json
{
  "thread_id": "conversation-id",
  "module": "obras",
  "record_id": 123,
  "title": "Nuevo titulo visible",
  "fields": {},
  "intent": "Actualizar el titulo visible del registro"
}
```

No intentes editar el titulo usando `fields: {"title": "..."}` salvo que el
modulo tenga un campo real con slug `title` descubierto por
`query_module_describe`. En la mayoria de registros Query, eso es distinto del
titulo visible.

Al terminar **no digas que el cambio quedo hecho**. No lo esta: esta esperando
que alguien lo apruebe. Decir lo contrario hace que den por cerrado algo que
sigue pendiente.

Antes de proponer, mira si ya propusiste eso mismo en este canal. Si la
respuesta trae `duplicate: true`, no se creo una segunda propuesta: la que ya
estaba sigue esperando y es la que hay que mencionar.

## Cuando la persona confirma escribiendo

No hace falta que pulsen el boton: quien conversa puede escribir "confirmo",
"aplicalo" o "descartalo" y Query lo resuelve al recibir ese mensaje. **Eso no
lo haces tu**: no tienes ninguna herramienta para cerrar tu propia propuesta, y
no debes buscar otra via para lograrlo.

Lo sabras porque el contexto del turno te lo dice:

- *ya aplico tu propuesta* — el cambio esta hecho. Confirmalo en pasado, con el
  registro que te indique, y no lo vuelvas a proponer.
- *descarto tu propuesta* — quedo sin efecto. No insistas.
- *hay N esperando y no se sabe cual* — pregunta cual antes de nada; ninguna se
  toco.
- *no tiene permiso para aplicarla* — sigue pendiente; que la apruebe alguien
  con ese permiso.

Si no aparece ninguna de esas lineas, la propuesta sigue esperando aprobacion,
aunque la persona haya escrito algo que a ti te suene a un si.

Si Query rechaza la propuesta, la respuesta trae el motivo: campo inexistente,
campo de solo lectura, valor fuera de las opciones permitidas o falta de
permiso. Corrige con esa informacion y vuelve a proponer; no insistas con el
mismo payload.
