# Pedirle al agente que consulte Query

El agente puede mirar tu sistema Query mientras conversas con él. No necesitas
saber nombres técnicos ni pasarle nada especial: **basta con pedírselo con
palabras normales, dentro del chat de Query**.

## No hay que enseñarle tu sistema

Cada organización configura Query a su manera: sus módulos, sus campos, sus
grupos de campos, sus estados. El agente no los trae aprendidos ni los adivina;
**los descubre en el momento**, mirando la configuración real de tu sistema.

Por eso puedes hablarle de lo que tienes tú sin explicarle nada antes. Y por eso
mismo, si algo cambia en la configuración, lo verá al instante: no hay nada que
actualizar en el agente.

## Cómo se le pide

Habla como hablarías con un compañero que acaba de entrar y tiene acceso a la
plataforma:

- «¿Qué hay en este sistema? ¿Qué módulos tengo disponibles?»
- «Explícame de qué trata este módulo y qué se registra ahí.»
- «¿Qué campos tiene, cuáles son obligatorios y qué estados maneja?»
- «Busca los registros que estén en tal estado.»
- «Ábreme ese registro y dime en qué va.»

Nombra las cosas como las ves en pantalla. Si le dices un nombre que no existe,
te lo dirá en vez de inventárselo.

## Entender un módulo, no solo listarlo

Una de las cosas más útiles es pedirle que te **explique** un módulo. Al mirar
su configuración —los grupos de campos, los tipos de dato, los estados posibles,
con qué otros módulos se relaciona— puede contarte en lenguaje normal para qué
sirve ese módulo y cómo está pensado el proceso, aunque sea la primera vez que
lo ve.

Es especialmente útil cuando heredas un sistema configurado por otra persona.

## Lo que verá y lo que no

El agente consulta **con tus permisos**, no con los suyos. Ve exactamente lo que
verías tú entrando a Query: si no tienes acceso a un módulo, para el agente ese
módulo no existe. Si dos personas le preguntan en canales distintos, cada una
recibe lo suyo.

Por eso, si a un compañero le encuentra algo y a ti te dice que no, casi siempre
es un tema de permisos en Query, no del agente.

## Si te dice que no encuentra la conversación

Puede responder algo como *«no hay una credencial vigente para ese canal»*. Pasa
cuando lleva un rato sin que le escribas: el permiso que Query le da para
consultar **caduca a los 15 minutos** por seguridad.

Se arregla solo: **escríbele un mensaje nuevo en ese canal y vuelve a
pedírselo**.

## Los recordatorios automáticos

Si tienes una tarea programada —por ejemplo un resumen cada mañana— no le pasa
lo anterior: pide su permiso sola al arrancar y consulta con **los permisos de
quien creó la tarea**. Si la creaste tú, ve lo que tú ves; si la creó otra
persona, lo que ve esa persona. Que alguien más responda en el canal no cambia
eso: cada quien sigue viendo lo suyo.

Si un recordatorio te dice que no pudo consultar, casi siempre es que quedó
registrado sin dueño (por ejemplo, se creó antes de que esto existiera en un
canal compartido). Se arregla volviéndolo a crear desde una conversación con la
persona en cuyo nombre debe correr.

## Consultar sí, cambiar no

Estas consultas son de lectura. Si le pides que **modifique o cree** un
registro, no lo hace directamente: deja una propuesta en el chat con el detalle
de qué cambiaría, y aparece un botón para aplicarla o descartarla. Nada se
guarda en Query hasta que una persona lo aprueba.

Si no ves el botón y solo el texto de la propuesta, es que no tienes permiso
para editar ese módulo; puede aplicarla alguien que sí lo tenga.

### Aprobar sin buscar el botón

No hace falta pulsarlo: si respondes **«confirmo»**, «aplícalo» o «apruébalo»,
se aplica igual. Y con «descártalo» o «cancela» queda sin efecto. Lo lee Query,
no el agente, así que sigue siendo tu decisión y queda registrada con tu
mensaje como constancia.

Dos cosas que **no** confirman, a propósito:

- Pedir algo nuevo. «Crea un registro en incidencias» es un encargo, no un sí a
  lo anterior.
- Un «sí» suelto cuando el agente acaba de hacerte otra pregunta: ahí no se
  sabe a cuál de las dos respondes. Dilo con todas las letras («confirmo») o
  usa el botón.

Si hay dos propuestas esperando, tampoco se toca ninguna: el agente te
preguntará cuál.

## Dónde funciona

En el chat de agentes de Query, en la web y en la app. En canales generales,
temáticos y en tu canal privado.
