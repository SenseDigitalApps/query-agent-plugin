import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { queryPlugin } from "./src/channel.js";
import { setQueryRuntime } from "./src/runtime.js";
import { registerQueryCronSync } from "./src/cron-sync.js";
import { registerQueryGoogleGuard } from "./src/google-guard.js";
import queryToolsEntry from "./src/query-tools.js";

export default defineChannelPluginEntry({
  id: "query",
  name: "Query",
  description: "Query web and Flutter messaging channel",
  plugin: queryPlugin,
  setRuntime: setQueryRuntime,
  registerFull: (api) => {
    if ("on" in api && typeof api.on === "function") {
      registerQueryCronSync(api);
      registerQueryGoogleGuard(api);
    }
    queryToolsEntry.register(api);
  },
});
