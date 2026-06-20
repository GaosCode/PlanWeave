import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RegisteredClient = {
  clientId: string;
  clientIdIssuedAt: number;
  clientName?: string;
  redirectUris: string[];
};

export type OAuthClientStore = {
  get(clientId: string): Promise<RegisteredClient | undefined>;
  set(client: RegisteredClient): Promise<void>;
};

type StoredClientFile = {
  version: 1;
  clients: RegisteredClient[];
};

export function createMemoryOAuthClientStore(): OAuthClientStore {
  const clients = new Map<string, RegisteredClient>();
  return {
    async get(clientId) {
      return clients.get(clientId);
    },
    async set(client) {
      clients.set(client.clientId, client);
    }
  };
}

export function createFileOAuthClientStore(path: string): OAuthClientStore {
  const clients = new Map<string, RegisteredClient>();
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
        const file = parseStoredClientFile(parsed);
        clients.clear();
        for (const client of file.clients) {
          clients.set(client.clientId, client);
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
    const file: StoredClientFile = {
      version: 1,
      clients: [...clients.values()].sort((left, right) => left.clientId.localeCompare(right.clientId))
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(`${path}.tmp`, path);
  }

  return {
    async get(clientId) {
      await load();
      return clients.get(clientId);
    },
    async set(client) {
      await load();
      clients.set(client.clientId, client);
      writePromise = writePromise.then(persist, persist);
      await writePromise;
    }
  };
}

function parseStoredClientFile(value: unknown): StoredClientFile {
  if (!value || typeof value !== "object") {
    throw new Error("OAuth client store must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.clients)) {
    throw new Error("OAuth client store has an unsupported format.");
  }
  return {
    version: 1,
    clients: record.clients.map(parseRegisteredClient)
  };
}

function parseRegisteredClient(value: unknown): RegisteredClient {
  if (!value || typeof value !== "object") {
    throw new Error("OAuth client store contains an invalid client.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.clientId !== "string" || typeof record.clientIdIssuedAt !== "number" || !Array.isArray(record.redirectUris)) {
    throw new Error("OAuth client store contains an invalid client.");
  }
  const redirectUris = record.redirectUris.filter((uri): uri is string => typeof uri === "string");
  if (redirectUris.length !== record.redirectUris.length) {
    throw new Error("OAuth client store contains an invalid redirect URI.");
  }
  if (record.clientName !== undefined && typeof record.clientName !== "string") {
    throw new Error("OAuth client store contains an invalid client name.");
  }
  return {
    clientId: record.clientId,
    clientIdIssuedAt: record.clientIdIssuedAt,
    clientName: record.clientName,
    redirectUris
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
