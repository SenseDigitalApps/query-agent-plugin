import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { queryPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(queryPlugin);
