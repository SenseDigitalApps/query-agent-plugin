import { resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";

type AuthConfig = Parameters<typeof resolveGatewayAuth>[0]["authConfig"];
/** Bootstrap only against this host; afterwards use the dedicated scoped device. */
export function voiceGatewayBootstrap(url: string, authConfig: AuthConfig,
    hasDeviceToken: boolean, env: NodeJS.ProcessEnv = process.env) {
  if (hasDeviceToken) return {};
  const endpoint = new URL(url);
  if (!["ws:", "wss:"].includes(endpoint.protocol) ||
      !["127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw Error("voice_gateway_bootstrap_requires_loopback");
  }
  const auth = resolveGatewayAuth({authConfig, env});
  if (auth.mode === "token" && auth.token) return {token: auth.token, preferBootstrapToken: true};
  if (auth.mode === "password" && auth.password) return {password: auth.password, preferBootstrapToken: true};
  throw Error("voice_gateway_bootstrap_unavailable");
}
