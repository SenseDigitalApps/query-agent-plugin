# Administración de crones desde Query Core

Implementación local del contrato `schedule.admin.*`; no requiere modificar OpenClaw.
El socket solo inicia polling cuando Core anuncia `schedule_administration_version: 1`
en `session.ready`. Consulta al conectar y cada 30 segundos, al siguiente heartbeat.

Core verifica permisos del administrador, consentimiento del ejecutor y autorización;
el plugin no utiliza el token del administrador ni el de una conversación. Requiere
`getCron().updateWithPrecondition`, disponible en el OpenClaw 2026.9.4 inspeccionado.
Si falta, devuelve `applied:false`; nunca degrada a un update sin bloqueo.

El comando lleva UUID correlacionado, ID externo, revisión SHA-256, hash de solicitud,
patch y `execute:false`. Se valida cuenta Query explícita, destino y revisión antes
de escribir, y nuevamente dentro del bloqueo nativo. La operación no llama `run`,
`add` ni `remove`. Rechaza jobs en ejecución y ediciones con un timer vencido que no
recalculen horario. Los horarios cron nativos se recalculan hacia su próxima fecha;
la validación de integración con el runtime desplegado sigue pendiente.

Los recibos se guardan junto al stateFile de respuestas, con sufijo
`.schedule-admin.json`. Solo contienen hashes, IDs y estado; no prompts ni credenciales.
Conservarlos al reiniciar o actualizar. Una intención durable previa a la escritura
permite reconocer el resultado después de un reinicio y reenviar ACK sin editar otra vez.
El snapshot observado se devuelve exclusivamente al socket autenticado de Core.
Solo tras recibir `schedule.admin.received` con `status=applied` se emite `schedule.sync` v2.

Los errores son códigos cerrados; las excepciones nativas se reducen a
`schedule_scheduler_rejected`. Entre los motivos accionables están
`schedule_atomic_update_unavailable`, `schedule_revision_conflict`,
`schedule_job_running`, `schedule_job_due`, `schedule_patch_not_lossless` y
`schedule_update_unconfirmed`. Core conserva el bloqueo de credenciales tras un fallo.
Revisar estado y solicitar una nueva operación explícita; no ejecutar el cron para diagnosticarlo.

Core materializa payload/delivery conservando restricciones opcionales existentes
(p. ej. toolsAllow). El plugin rechaza un patch que las elimine implícitamente.
No cambia run_as: esa autorización solo la persiste Core tras consentimiento y ACK.

## Validación y despliegue

Usar dependencias ya instaladas y fixtures sintéticos. `npm run check` y `npm run build`
no arrancan el gateway. Los tests administrativos usan un planificador simulado.
La batería de protocolo/socket usa únicamente sockets locales.

```powershell
npm run check
npm run build
.\node_modules\.bin\vitest.cmd run src/schedule-administration.test.ts src/protocol.test.ts src/cron-sync.test.ts src/schedule-confirmation.test.ts src/scheduled-context.test.ts src/socket.test.ts --maxWorkers=1 --minWorkers=1
```

Antes de desplegar: respaldar fuentes, paquete instalado y recibos; aplicar migración
0047 y backend de Core compatible. Compilar/empaquetar por el procedimiento habitual,
instalar en el entorno elegido y reiniciar su gateway en una ventana controlada.
No se instaló ni reinició ningún gateway durante este trabajo local.

Rollback: reconciliar primero operaciones pendientes, fallidas y pausas en Core.
Restaurar el paquete anterior sin borrar recibos ni auditorías; el plugin anterior no
procesará operaciones administrativas. No revertir ciegamente tablas de Core ni
recrear jobs. Usar una operación compensatoria sobre el mismo ID, con nuevo consentimiento
cuando corresponda. El runbook de Query Core detalla respaldo selectivo y rollback.
