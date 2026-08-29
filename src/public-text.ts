/**
 * OpenClaw puede insertar anotaciones de control del modo rapido dentro del
 * stream de texto. Son telemetria del runtime, no contenido escrito por el
 * agente, y por eso nunca deben cruzar el limite publico de Query.
 *
 * El prefijo con emoji y el valor exacto `auto-on`/`auto-off` hacen el filtro
 * deliberadamente estrecho: una respuesta legitima que hable de algo llamado
 * "Fast" permanece intacta.
 */
const FAST_MODE_CONTROL_ANNOTATION =
  /\u{1F4A8}\uFE0F?\s*Fast:\s*auto-(?:on|off)(?:\([^\r\n)]{0,120}\))?/giu;

export function stripOpenClawControlAnnotations(text: string): string {
  return text.replace(FAST_MODE_CONTROL_ANNOTATION, "");
}
