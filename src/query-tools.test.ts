import { describe, expect, it } from "vitest";

import { containsGeneratedArtifactReference } from "./query-tools.js";

describe("containsGeneratedArtifactReference", () => {
  it("detects local generated artifacts in proposed record fields", () => {
    expect(
      containsGeneratedArtifactReference({
        fields: {
          reporte:
            "/home/ubuntu/.openclaw/workspace/tenants/query/agents/elonmusk/workspace/artifacts/reporte.html",
        },
      }),
    ).toBe(true);
  });

  it("detects public URLs that leak a server-local generated artifact path", () => {
    expect(
      containsGeneratedArtifactReference({
        fields: {
          reporte:
            "https://us.itsquery.com/home/ubuntu/.openclaw/workspace/tenants/query/agents/elonmusk/workspace/artifacts/reporte.pdf",
        },
      }),
    ).toBe(true);
  });

  it("does not block ordinary record data", () => {
    expect(
      containsGeneratedArtifactReference({
        title: "Estado de Resultados Query - Junio y Julio 2026",
        fields: {
          estado: "Listo",
          url: "https://apius.itsquery.com/media/public/agent_chat/reporte.pdf",
        },
      }),
    ).toBe(false);
  });
});
