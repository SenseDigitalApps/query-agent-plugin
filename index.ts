import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { queryPlugin } from "./src/channel.js";
import { setQueryRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "query",
  name: "Query",
  description: "Query web and Flutter messaging channel",
  plugin: queryPlugin,
  setRuntime: setQueryRuntime,
});
