import { readFile } from "node:fs/promises";
import { writePrivateJsonFile } from "./privateJsonFile.js";

export type StoredAccessToken = {
  tokenHash: string;
  clientId: string;
  expiresAt: number;
  resource: string;
  scope: string;
};

export type OAuthTokenStore = {
  get(tokenHash: string): Promise<StoredAccessToken | undefined>;
  set(token: StoredAccessToken): Promise<void>;
  delete(tokenHash: string): Promise<void>;
};

type StoredTokenFile = {
  version: 1;
  tokens: StoredAccessToken[];
};

export function createMemoryOAuthTokenStore(): OAuthTokenStore {
  const tokens = new Map<string, StoredAccessToken>();
  return {
    async get(tokenHash) {
      return tokens.get(tokenHash);
    },
    async set(token) {
      tokens.set(token.tokenHash, token);
    },
    async delete(tokenHash) {
      tokens.delete(tokenHash);
    }
  };
}

export function createFileOAuthTokenStore(path: string): OAuthTokenStore {
  const tokens = new Map<string, StoredAccessToken>();
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  let writePromise = Promise.resolve();

  async function load(): Promise<void> {
    if (loaded) {
      return;
    }
    loadPromise ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
        const file = parseStoredTokenFile(parsed);
        tokens.clear();
        for (const token of file.tokens) {
          tokens.set(token.tokenHash, token);
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          loaded = true;
          return;
        }
        throw error;
      }
      loaded = true;
    })();
    await loadPromise;
  }

  async function persist(): Promise<void> {
    const now = Date.now();
    for (const token of tokens.values()) {
      if (token.expiresAt <= now) {
        tokens.delete(token.tokenHash);
      }
    }
    const file: StoredTokenFile = {
      version: 1,
      tokens: [...tokens.values()].sort((left, right) =>
        left.tokenHash.localeCompare(right.tokenHash)
      )
    };
    await writePrivateJsonFile(path, file);
  }

  return {
    async get(tokenHash) {
      await load();
      return tokens.get(tokenHash);
    },
    async set(token) {
      await load();
      tokens.set(token.tokenHash, token);
      writePromise = writePromise.then(persist, persist);
      await writePromise;
    },
    async delete(tokenHash) {
      await load();
      tokens.delete(tokenHash);
      writePromise = writePromise.then(persist, persist);
      await writePromise;
    }
  };
}

function parseStoredTokenFile(value: unknown): StoredTokenFile {
  if (!value || typeof value !== "object") {
    throw new Error("OAuth token store must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.tokens)) {
    throw new Error("OAuth token store has an unsupported format.");
  }
  return {
    version: 1,
    tokens: record.tokens.map(parseStoredAccessToken)
  };
}

function parseStoredAccessToken(value: unknown): StoredAccessToken {
  if (!value || typeof value !== "object") {
    throw new Error("OAuth token store contains an invalid token.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.tokenHash !== "string" ||
    typeof record.clientId !== "string" ||
    typeof record.expiresAt !== "number" ||
    typeof record.resource !== "string" ||
    typeof record.scope !== "string"
  ) {
    throw new Error("OAuth token store contains an invalid token.");
  }
  return {
    tokenHash: record.tokenHash,
    clientId: record.clientId,
    expiresAt: record.expiresAt,
    resource: record.resource,
    scope: record.scope
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
