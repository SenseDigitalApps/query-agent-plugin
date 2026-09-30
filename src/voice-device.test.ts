import { afterEach, expect, it } from "vitest";
import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceOperatorDevice, deviceIdFromPublicKey } from "./voice-device.js";

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, {recursive: true, force: true}); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "query-voice-device-")); dirs.push(d); return d; };

it("creates one persistent Ed25519 identity with OpenClaw's device id fingerprint", () => {
  const directory = dir();
  const first = new VoiceOperatorDevice(directory).loadOrCreateIdentity();
  const again = new VoiceOperatorDevice(directory).loadOrCreateIdentity();
  expect(again).toEqual(first);
  // OpenClaw: sha256 hex of the raw 32-byte key (SPKI DER minus the 12-byte prefix).
  const raw = createPublicKey(first.publicKeyPem).export({type: "spki", format: "der"}).subarray(12);
  expect(raw.length).toBe(32);
  expect(first.deviceId).toBe(createHash("sha256").update(raw).digest("hex"));
  expect(deviceIdFromPublicKey(first.publicKeyPem)).toBe(first.deviceId);
});

it("keeps its own token store and ignores a token with admin scopes", () => {
  const {identity, deps} = new VoiceOperatorDevice(dir()).hostDeps();
  const params = {deviceId: identity.deviceId, role: "operator"};
  expect(deps.loadDeviceAuthToken(params)).toBeNull();
  deps.storeDeviceAuthToken({...params, token: "t-write", scopes: ["operator.write", "operator.read", "operator.talk"]});
  expect(deps.loadDeviceAuthToken(params)).toEqual({token: "t-write", scopes: ["operator.write", "operator.read", "operator.talk"]});
  deps.storeDeviceAuthToken({...params, token: "t-admin", scopes: ["operator.write", "operator.admin"]});
  expect(deps.loadDeviceAuthToken(params)).toBeNull();
  deps.clearDeviceAuthToken(params);
  expect(deps.loadDeviceAuthToken(params)).toBeNull();
  expect(deps.loadOrCreateDeviceIdentity()).toBe(identity);
});
