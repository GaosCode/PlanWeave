import { readFile } from "node:fs/promises";
import { writePrivateJsonFile } from "./privateJsonFile.js";

type StoredOAuthTokenBase = {
  tokenHash: string;
  clientId: string;
  expiresAt: number;
  resource: string;
  scope: string;
};

export type StoredAccessToken = StoredOAuthTokenBase & {
  kind: "access";
};

export type StoredRefreshToken = StoredOAuthTokenBase & {
  kind: "refresh";
};

export type StoredOAuthToken = StoredAccessToken | StoredRefreshToken;

export type OAuthTokenStore = {
  get(tokenHash: string): Promise<StoredOAuthToken | undefined>;
  set(token: StoredOAuthToken): Promise<void>;
  setMany(tokens: StoredOAuthToken[]): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  replace(
    tokenHash: string,
    replacements: StoredOAuthToken[]
  ): Promise<StoredOAuthToken | undefined>;
};

type StoredTokenFile = {
  version: 2;
  tokens: StoredOAuthToken[];
};

export function createMemoryOAuthTokenStore(): OAuthTokenStore {
  const tokens = new Map<string, StoredOAuthToken>();
  return {
    async get(tokenHash) {
      return tokens.get(tokenHash);
    },
    async set(token) {
      tokens.set(token.tokenHash, token);
    },
    async setMany(newTokens) {
      for (const token of newTokens) {
        tokens.set(token.tokenHash, token);
      }
    },
    async delete(tokenHash) {
      tokens.delete(tokenHash);
    },
    async replace(tokenHash, replacements) {
      const existing = tokens.get(tokenHash);
      if (!existing || existing.expiresAt <= Date.now()) {
        tokens.delete(tokenHash);
        return;
      }
      tokens.delete(tokenHash);
      for (const replacement of replacements) {
        tokens.set(replacement.tokenHash, replacement);
      }
      return existing;
    }
  };
}

export function createFileOAuthTokenStore(path: string): OAuthTokenStore {
  const tokens = new Map<string, StoredOAuthToken>();
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

  async function persist(nextTokens: Map<string, StoredOAuthToken>): Promise<void> {
    const now = Date.now();
    for (const token of nextTokens.values()) {
      if (token.expiresAt <= now) {
        nextTokens.delete(token.tokenHash);
      }
    }
    const file: StoredTokenFile = {
      version: 2,
      tokens: [...nextTokens.values()].sort((left, right) =>
        left.tokenHash.localeCompare(right.tokenHash)
      )
    };
    await writePrivateJsonFile(path, file);
  }

  async function mutate<T>(
    operation: (nextTokens: Map<string, StoredOAuthToken>) => T
  ): Promise<T> {
    await load();
    let result: T;
    const write = async () => {
      const nextTokens = new Map(tokens);
      result = operation(nextTokens);
      await persist(nextTokens);
      tokens.clear();
      for (const token of nextTokens.values()) {
        tokens.set(token.tokenHash, token);
      }
    };
    writePromise = writePromise.then(write, write);
    await writePromise;
    return result!;
  }

  return {
    async get(tokenHash) {
      await load();
      await writePromise;
      return tokens.get(tokenHash);
    },
    async set(token) {
      await mutate((nextTokens) => {
        nextTokens.set(token.tokenHash, token);
      });
    },
    async setMany(newTokens) {
      await mutate((nextTokens) => {
        for (const token of newTokens) {
          nextTokens.set(token.tokenHash, token);
        }
      });
    },
    async delete(tokenHash) {
      await mutate((nextTokens) => {
        nextTokens.delete(tokenHash);
      });
    },
    async replace(tokenHash, replacements) {
      return mutate((nextTokens) => {
        const existing = nextTokens.get(tokenHash);
        if (!existing || existing.expiresAt <= Date.now()) {
          nextTokens.delete(tokenHash);
          return;
        }
        nextTokens.delete(tokenHash);
        for (const replacement of replacements) {
          nextTokens.set(replacement.tokenHash, replacement);
        }
        return existing;
      });
    }
  };
}

function parseStoredTokenFile(value: unknown): StoredTokenFile {
  if (!value || typeof value !== "object") {
    throw new Error("OAuth token store must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tokens)) {
    throw new Error("OAuth token store has an unsupported format.");
  }
  if (record.version === 1) {
    return {
      version: 2,
      tokens: record.tokens.map((token) => parseStoredOAuthToken(token, "access"))
    };
  }
  if (record.version === 2) {
    return {
      version: 2,
      tokens: record.tokens.map((token) => parseStoredOAuthToken(token))
    };
  }
  throw new Error("OAuth token store has an unsupported format.");
}

function parseStoredOAuthToken(
  value: unknown,
  migratedKind?: StoredOAuthToken["kind"]
): StoredOAuthToken {
  if (!value || typeof value !== "object") {
    throw new Error("OAuth token store contains an invalid token.");
  }
  const record = value as Record<string, unknown>;
  const kind = migratedKind ?? record.kind;
  if (
    (kind !== "access" && kind !== "refresh") ||
    typeof record.tokenHash !== "string" ||
    typeof record.clientId !== "string" ||
    typeof record.expiresAt !== "number" ||
    typeof record.resource !== "string" ||
    typeof record.scope !== "string"
  ) {
    throw new Error("OAuth token store contains an invalid token.");
  }
  return {
    kind,
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
