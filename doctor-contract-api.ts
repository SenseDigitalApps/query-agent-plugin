/**
 * Offline Doctor contract: this plugin release does not change persisted formats.
 * Query keeps its existing JSON stores and supports legacy account configuration
 * in its readers. No OpenClaw-owned session/store migration is requested here.
 * Keep this module free of runtime/channel/voice imports: Doctor runs offline.
 * Add explicit migrations here and in the manifest if persisted formats change.
 */
export const stateMigrations = [];
