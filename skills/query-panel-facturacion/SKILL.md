---
name: query-panel-facturacion
description: 'Facturación electrónica Matias desde Query (query_billing_*): disponibilidad, emisión, documentos y conciliación. Leer junto con query-panel.'
---

# query-panel-facturacion

Anexo temático de `query-panel`. Las reglas generales de `query-panel` (guardrails, permisos, propuestas, credenciales) siguen aplicando; si no las has cargado en este turno, léelas primero con `skills_read` (name: `query-panel`).

## Facturacion electronica Matias

Antes de operar, descubre modulos y registros con las herramientas Query y resuelve
sus IDs exactos. Carga herramientas diferidas con tool_search; en modo codigo
busca por nombre en ALL_TOOLS. No declares una herramienta ausente sin buscarla.

1. Usa `query_billing_availability` con `items: [{module_id, record_id}]` (1–50
   pares unicos) para verificar configuracion, modo y permisos del usuario actual.
2. Una consulta de estado usa `query_billing_status`, no emision.
3. Solo cuando el mensaje humano actual pide explicitamente emitir, usa
   `query_billing_emit` con los mismos items y `user_request` como cita textual
   de esa solicitud. Esta autoriza el lote identificado sin otra confirmacion;
   no emitas desde cron ni por el solo hecho de crear un registro.
4. Revisa TODOS los resultados, aunque HTTP sea 200: `record_created` o
   `record_exists` son borradores, no facturas emitidas. Descubre y revisa el
   registro fiscal `draft.module_id`/`draft.id` antes de emitirlo bajo la misma
   solicitud. `queued` es solo encolado; solo `issued`/`emitted=true` confirma.
5. Ante timeout, `billing_result_unknown`, `pending`, `unknown` o
   `reconciliation_required`, conserva IDs y consulta `query_billing_status`
   y `query_billing_reconcile`; nunca reenvies automaticamente.
6. `query_billing_documents` con `formats: ["pdf", "xml"]` obtiene adjuntos
   descargables del chat. No inventes enlaces ni uses rutas web de Matias.

`billing_bridge_unavailable` requiere desplegar el puente de Core; no autoriza
usar otra API, editar campos fiscales o pedir credenciales. Estas herramientas
mantienen el tenant y permisos del usuario efectivo; habilitarlas no concede
permisos fiscales a nadie. No solicites ni expongas secretos de Matias.

