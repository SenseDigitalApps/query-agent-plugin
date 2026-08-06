---
name: query-panel
description: Read and change Query panel data on behalf of the person you are chatting with, using their own permissions. Use whenever someone asks what exists in their system, what a module is about, which fields it has, asks to find or open records, or asks to create or modify a record. Every write goes through a proposal that a human confirms; never write to Query by any other route. Discovery-first: never assume module or field names.
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
   lectura y que opciones exactas admite cada campo de seleccion.
3. `query_records_search` — busca con el slug real del campo y el valor exacto
   que devolvio el paso 2.
4. `query_record_get` — abre un registro concreto cuando necesites todo su
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

## Cambiar datos: siempre propuesta, nunca ejecucion

`query_record_propose` es la **unica** via para tocar datos de Query. Sirve
tanto para crear como para actualizar, y no aplica nada: deja la propuesta en el
chat y una persona la confirma con un boton.

Nunca escribas en Query por otro camino, aunque dispongas de otra herramienta,
otro token o la API general. Si crees que hace falta escribir de otra forma,
dilo y detente.

Flujo:

1. `query_module_describe` — consigue los slugs reales y los valores exactos que
   admite cada campo. Un slug inventado hace fallar la propuesta entera.
2. `query_records_search` o `query_record_get` — si vas a actualizar, mira antes
   como esta el registro. Para llenar un campo relacional `ref_*`, busca tambien
   el registro relacionado y usa `{"id": ...}`; si solo conoces el consecutivo,
   usa `{"consecutivo": ...}`. No inventes `label`, `type`, `module` ni
   `module_name`, porque Query construye y valida ese objeto.
3. `query_record_propose` — con `record_id` para actualizar, sin el para crear.
   Incluye `intent`: una frase que explique por que, porque la lee la persona
   que decide.
4. Avisa que la propuesta quedo en el chat esperando aprobacion.

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
