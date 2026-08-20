import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readConfiguredGoogleAccountEmail,
  setOpenClawConfigLoader,
} from "./google-accounts.js";

/**
 * De donde sale el correo que Query puede creerse.
 *
 * Todo lo que se lee aqui lo escribio un operador en la maquina. Esa es la
 * unica razon por la que Query lo admite como prueba: el modelo elige el
 * ``accountId``, pero no puede editar este archivo. Si el dato no aparece o no
 * se reconoce, la respuesta es cadena vacia y el vinculo automatico no ocurre —
 * nunca una suposicion.
 */

const EMAIL = "jc.vargas2150@gmail.com";

function withPluginConfig(config: unknown, pluginId = "google-workspace") {
  setOpenClawConfigLoader(() => ({
    plugins: { entries: { [pluginId]: { config } } },
  }));
}

afterEach(() => {
  setOpenClawConfigLoader(undefined);
  delete process.env.QUERY_GOOGLE_WORKSPACE_PLUGIN_IDS;
  delete process.env.QUERY_GOOGLE_WORKSPACE_ACCOUNTS_FILE;
});

describe("correo configurado de una cuenta de Google", () => {
  it("lee el expectedEmail de un mapa de cuentas por id", async () => {
    withPluginConfig({ accounts: { jcvargas: { expectedEmail: EMAIL } } });
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe(EMAIL);
  });

  it("lee el expectedEmail de una lista de cuentas", async () => {
    withPluginConfig({
      accounts: [
        { id: "felotaca", expectedEmail: "felotaca@gmail.com" },
        { id: "jcvargas", expectedEmail: EMAIL },
      ],
    });
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe(EMAIL);
  });

  it("no distingue mayusculas ni en el id ni en el correo", async () => {
    withPluginConfig({ accounts: { JCVargas: { expectedEmail: "JC.Vargas2150@Gmail.com" } } });
    expect(await readConfiguredGoogleAccountEmail("  jcvargas ")).toBe(EMAIL);
  });

  it("acepta las cuentas colgadas de la raiz de la config", async () => {
    withPluginConfig({ jcvargas: { expectedEmail: EMAIL } });
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe(EMAIL);
  });

  it("devuelve vacio cuando la cuenta no declara correo", async () => {
    withPluginConfig({ accounts: { jcvargas: { scopes: ["gmail.readonly"] } } });
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe("");
  });

  it("devuelve vacio cuando la cuenta no esta configurada aqui", async () => {
    withPluginConfig({ accounts: { felotaca: { expectedEmail: "felotaca@gmail.com" } } });
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe("");
  });

  it("no se cree un valor que no parece un correo", async () => {
    withPluginConfig({ accounts: { jcvargas: { expectedEmail: "la cuenta de juli" } } });
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe("");
  });

  it("lee la forma que tiene la maquina real", async () => {
    // Tal cual esta en ``openclaw.json``: ``plugins.entries`` como objeto
    // indexado por id, la entrada del plugin llamada ``openclaw-google-workspace``,
    // y ``accounts`` como mapa por ``accountId`` con campos de adorno al lado.
    setOpenClawConfigLoader(() => ({
      plugins: {
        entries: {
          "openclaw-google-workspace": {
            config: {
              accounts: {
                jcvargas: {
                  expectedEmail: EMAIL,
                  label: "Julian Vargas / Query",
                },
              },
            },
          },
        },
      },
    }));
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe(EMAIL);
  });

  it("tambien entiende plugins.entries como lista", async () => {
    // No es lo que hay hoy. Se soporta para que un cambio de forma no deje al
    // lector devolviendo cero cuentas sin decir por que.
    setOpenClawConfigLoader(() => ({
      plugins: {
        entries: [
          { id: "slack", config: { accounts: { jcvargas: { expectedEmail: "no@es.este" } } } },
          {
            id: "openclaw-google-workspace",
            config: { accounts: { jcvargas: { expectedEmail: EMAIL } } },
          },
        ],
      },
    }));
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe(EMAIL);
  });

  it("no toma cuentas de un plugin que no es el de Google", async () => {
    withPluginConfig({ accounts: { jcvargas: { expectedEmail: EMAIL } } }, "slack");
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe("");
  });

  it("puede apuntar a un id de plugin explicito", async () => {
    process.env.QUERY_GOOGLE_WORKSPACE_PLUGIN_IDS = "gog-vault77";
    withPluginConfig({ accounts: { jcvargas: { expectedEmail: EMAIL } } }, "gog-vault77");
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe(EMAIL);
  });

  it("devuelve vacio si la config no se puede leer", async () => {
    // Que la config falle cierra el vinculo automatico, no lo abre: sin correo
    // Query responde 403 igual que antes de que esto existiera.
    setOpenClawConfigLoader(() => {
      throw new Error("config ilegible");
    });
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe("");
  });

  it("devuelve vacio cuando no hay ninguna cuenta configurada", async () => {
    setOpenClawConfigLoader(() => ({}));
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe("");
  });

  it("puede leer las cuentas de un archivo aparte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "query-google-accounts-"));
    try {
      const file = join(dir, "accounts.json");
      writeFileSync(file, JSON.stringify({ accounts: { jcvargas: { expectedEmail: EMAIL } } }));
      process.env.QUERY_GOOGLE_WORKSPACE_ACCOUNTS_FILE = file;
      setOpenClawConfigLoader(() => ({}));
      expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe(EMAIL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("un archivo que no existe no rompe ni inventa nada", async () => {
    process.env.QUERY_GOOGLE_WORKSPACE_ACCOUNTS_FILE = join(
      tmpdir(),
      "query-no-existe-jamas.json",
    );
    withPluginConfig({ accounts: { jcvargas: { expectedEmail: EMAIL } } });
    // La config sigue siendo la fuente: el archivo es un complemento, no un
    // interruptor que apague lo demas.
    expect(await readConfiguredGoogleAccountEmail("jcvargas")).toBe(EMAIL);
  });
});
