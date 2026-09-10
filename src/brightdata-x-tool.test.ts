import { describe, expect, it, vi } from "vitest";
import { fetchBrightDataXProfilePosts, registerBrightDataXTool } from "./brightdata-x-tool.js";

describe("Bright Data X dynamic tool", () => {
  it("sends the verified dataset request without exposing the token", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) =>
      new Response(JSON.stringify([{ id: "post-1" }]), { status: 200 }),
    );
    const result = await fetchBrightDataXProfilePosts({
      profile_urls: ["https://x.com/JUANquenza"],
      num_of_posts: 2,
      include_reposts: false,
    }, { token: "secret-token", fetchImpl: fetchImpl as typeof fetch });

    expect(result).toMatchObject({ ok: true, dataset_id: "gd_lwxkxvnf1cynvib9co", count: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("discover_by=profile_url");
    expect(String(url)).toContain("dataset_id=gd_lwxkxvnf1cynvib9co");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-token" });
    expect(init?.body).toContain('"url":"https://x.com/JUANquenza"');
  });

  it("is visible only to the three approved agents", () => {
    let factory: ((context: { agentId?: string }) => unknown) | undefined;
    const api = {
      registerTool: vi.fn((received: typeof factory) => { factory = received; }),
    };
    registerBrightDataXTool(api as never);
    expect(factory?.({ agentId: "comunicaciones" })).toMatchObject({ name: "brightdata_x_profile_posts" });
    expect(factory?.({ agentId: "congreso" })).toMatchObject({ name: "brightdata_x_profile_posts" });
    expect(factory?.({ agentId: "manuela-villegas-marketing" })).toMatchObject({ name: "brightdata_x_profile_posts" });
    expect(factory?.({ agentId: "main" })).toBeNull();
    expect(factory?.({ agentId: "proyectos" })).toBeNull();
  });
});
