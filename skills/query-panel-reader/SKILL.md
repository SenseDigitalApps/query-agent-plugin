---
name: query-panel-reader
description: Read modules, field configuration and records from the Query panel on behalf of the person you are chatting with, using their own permissions. Use whenever someone asks what exists in their system, what a module is about, which fields it has, or asks to find, filter or open records. Discovery-first: never assume module or field names.
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

## Escribir no es parte de esto

Estas herramientas solo leen. Un cambio en los datos se propone y lo confirma
una persona desde la interfaz de Query. Si te piden modificar algo, explica que
dejaras la propuesta y que alguien con permiso debe aplicarla.
