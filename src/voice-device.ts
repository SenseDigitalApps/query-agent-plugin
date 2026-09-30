/**
 * Dedicated operator device for the voice bridge. It is NOT the Gateway's shared
 * identity nor an existing Control UI operator: its own Ed25519 key and token
 * live in a private directory, and it only ever asks for `operator.write`.
 *
 * Pairing flow (OpenClaw 2026.9.4): the first connection creates a pending
 * request; an authorized operator approves that exact request
 * (`openclaw devices list` / `openclaw devices approve <requestId>`); the
 * Gateway then issues a device token that GatewayClient stores through
 * `storeDeviceAuthToken` below. Tokens are never logged.
 */
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VOICE_OPERATOR_ROLE = "operator";
export const VOICE_OPERATOR_SCOPES = Object.freeze(["operator.write"]);

export type VoiceDeviceIdentity = { deviceId: string; privateKeyPem: string; publicKeyPem: string };
type TokenRecord = { token: string; scopes: string[] };

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw key is the next 32 bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Same fingerprint OpenClaw uses: sha256 hex of the raw 32-byte public key. */
export function deviceIdFromPublicKey(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({type: "spki", format: "der"});
  if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw Error("voice_device_key_not_ed25519");
  }
  return createHash("sha256").update(der.subarray(ED25519_SPKI_PREFIX.length)).digest("hex");
}

function writePrivate(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), {mode: 0o600});
  renameSync(`${path}.tmp`, path);
  try { chmodSync(path, 0o600); } catch { /* Best effort on filesystems without modes. */ }
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class VoiceOperatorDevice {
  private identityPath: string;
  private tokenPath: string;

  constructor(private directory: string) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    try { chmodSync(directory, 0o700); } catch { /* Best effort. */ }
    this.identityPath = join(directory, "identity.json");
    this.tokenPath = join(directory, "device-token.json");
  }

  loadOrCreateIdentity(): VoiceDeviceIdentity {
    const stored = readJson<VoiceDeviceIdentity>(this.identityPath);
    if (stored) {
      if (deviceIdFromPublicKey(stored.publicKeyPem) !== stored.deviceId) throw Error("voice_device_identity_corrupt");
      return stored;
    }
    const {publicKey, privateKey} = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({type: "spki", format: "pem"}).toString();
    const privateKeyPem = privateKey.export({type: "pkcs8", format: "pem"}).toString();
    const identity = {deviceId: deviceIdFromPublicKey(publicKeyPem), publicKeyPem, privateKeyPem};
    writePrivate(this.identityPath, identity);
    return identity;
  }

  private tokens(): Record<string, TokenRecord> {
    return readJson<Record<string, TokenRecord>>(this.tokenPath) ?? {};
  }

  /** GatewayClient host dependencies: this device only, never the shared store. */
  hostDeps() {
    const identity = this.loadOrCreateIdentity();
    const key = (deviceId: string, role: string) => `${deviceId}:${role}`;
    return {
      identity,
      deps: {
        loadOrCreateDeviceIdentity: () => identity,
        loadDeviceAuthToken: ({deviceId, role}: {deviceId: string; role: string}) => {
          const record = this.tokens()[key(deviceId, role)];
          // A token that gained scopes beyond operator.write is not used.
          if (!record || record.scopes.some(scope => !VOICE_OPERATOR_SCOPES.includes(scope as never) &&
              scope !== "operator.read" && scope !== "operator.talk")) return null;
          return record;
        },
        storeDeviceAuthToken: ({deviceId, role, token, scopes}: {deviceId: string; role: string; token: string; scopes: string[]}) => {
          writePrivate(this.tokenPath, {...this.tokens(), [key(deviceId, role)]: {token, scopes}});
        },
        clearDeviceAuthToken: ({deviceId, role}: {deviceId: string; role: string}) => {
          const all = this.tokens();
          delete all[key(deviceId, role)];
          writePrivate(this.tokenPath, all);
        },
      },
    };
  }
}
