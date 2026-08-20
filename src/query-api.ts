/**
 * De donde cuelga la API de Query para una cuenta viva.
 *
 * La URL del WebSocket es lo unico que el plugin conoce con certeza de cada
 * tenant, asi que el endpoint REST se deriva de ella en vez de configurarse
 * aparte: dos valores que hay que mantener sincronizados a mano terminan
 * apuntando a sitios distintos el dia que alguien migra un dominio.
 */
export function queryApiUrl(socketUrl: string, path: string): string {
  const parsed = new URL(socketUrl);
  parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `/api/v4/openclaw-agent/${path}`.replace(/\/{2,}/g, "/");
  return parsed.toString();
}
