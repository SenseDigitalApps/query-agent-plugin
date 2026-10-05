import {afterEach, describe, expect, it, vi} from "vitest";
import {registerQueryVoice} from "./voice-register.js";

const calls = vi.hoisted(() => ({device: vi.fn(), bootstrap: vi.fn(), client: vi.fn()}));
vi.mock("./voice-device.js", () => ({
  VOICE_OPERATOR_ROLE: "operator", VOICE_OPERATOR_SCOPES: ["operator.write"],
  VoiceOperatorDevice: class { constructor() { calls.device(); throw new Error("device-init-reached"); } },
}));
vi.mock("./voice-gateway-auth.js", () => ({voiceGatewayBootstrap: calls.bootstrap}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({GatewayClient: calls.client}));
function api() {
  return {on: vi.fn(), config: {channels: {query: {voice: {enabled: true}}}},
    logger: {info: vi.fn(), warn: vi.fn()}, registerService: vi.fn(), registerHttpRoute: vi.fn()};
}
afterEach(() => {vi.unstubAllEnvs(); vi.clearAllMocks();});
describe("Query voice channel-disabled rehearsal", () => {
  it("retains authorization hooks without touching devices or external transports", () => {
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "1");
    vi.stubEnv("QUERY_AGENT_VOICE_BRIDGE_TOKEN", "x".repeat(32));
    const a=api();
    expect(() => registerQueryVoice(a as never)).not.toThrow();
    expect(a.on.mock.calls.map(c=>c[0])).toEqual(["llm_input", "before_agent_run", "before_prompt_build", "before_tool_call"]);
    expect(calls.device).not.toHaveBeenCalled();
    expect(calls.bootstrap).not.toHaveBeenCalled();
    expect(calls.client).not.toHaveBeenCalled();
    expect(a.registerHttpRoute).not.toHaveBeenCalled();
  });
  it("defers live initialization until Gateway service start", () => {
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "0");
    vi.stubEnv("QUERY_AGENT_VOICE_BRIDGE_TOKEN", "x".repeat(32));
    const a = api();
    expect(() => registerQueryVoice(a as never)).not.toThrow();
    expect(calls.device).not.toHaveBeenCalled();
    expect(calls.bootstrap).not.toHaveBeenCalled();
    expect(a.registerHttpRoute).toHaveBeenCalledTimes(1);
    const service = a.registerService.mock.calls[0][0];
    expect(() => service.stop()).not.toThrow();
    expect(() => service.start()).toThrow("device-init-reached");
    expect(calls.device).toHaveBeenCalledTimes(1);
  });
});
