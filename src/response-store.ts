import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { CachedResponse } from "./types.js";

const MAX_RESPONSES = 2_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type StoreDocument = {
  version: 1;
  responses: CachedResponse[];
};

export function defaultResponseStorePath(accountId: string): string {
  const stateRoot = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  return join(stateRoot, "query-channel", accountId, "responses.json");
}

export class ResponseStore {
  readonly filePath: string;
  private readonly responses = new Map<string, CachedResponse>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (!isAbsolute(filePath)) {
      throw new Error("Query stateFile must be an absolute path.");
    }
    this.filePath = filePath;
  }

  async load(now = Date.now()): Promise<void> {
    let document: StoreDocument;
    try {
      document = JSON.parse(await readFile(this.filePath, "utf8")) as StoreDocument;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || error instanceof SyntaxError) {
        return;
      }
      throw error;
    }
    if (document.version !== 1 || !Array.isArray(document.responses)) {
      return;
    }
    for (const response of document.responses) {
      if (
        response &&
        typeof response.clientMsgId === "string" &&
        now - response.completedAt <= MAX_AGE_MS
      ) {
        this.responses.set(response.clientMsgId, response);
      }
    }
    this.prune(now);
  }

  get(clientMsgId: string): CachedResponse | undefined {
    return this.responses.get(clientMsgId);
  }

  async set(response: CachedResponse): Promise<void> {
    this.responses.delete(response.clientMsgId);
    this.responses.set(response.clientMsgId, response);
    this.prune(Date.now());
    this.writeChain = this.writeChain.then(() => this.persist());
    await this.writeChain;
  }

  private prune(now: number): void {
    for (const [key, response] of this.responses) {
      if (now - response.completedAt > MAX_AGE_MS) {
        this.responses.delete(key);
      }
    }
    while (this.responses.size > MAX_RESPONSES) {
      const oldest = this.responses.keys().next().value as string | undefined;
      if (!oldest) break;
      this.responses.delete(oldest);
    }
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const document: StoreDocument = { version: 1, responses: [...this.responses.values()] };
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
