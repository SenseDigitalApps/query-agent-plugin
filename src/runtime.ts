import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";

let pluginRuntime: PluginRuntime | undefined;

export function setQueryRuntime(runtime: PluginRuntime): void {
  pluginRuntime = runtime;
}

export function getQueryRuntime(): PluginRuntime {
  if (!pluginRuntime) {
    throw new Error("Query plugin runtime has not been initialized.");
  }
  return pluginRuntime;
}
