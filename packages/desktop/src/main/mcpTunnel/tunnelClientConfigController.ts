import type { DesktopCredentialStorage } from "../credentialStorage/applicationCredentialStorage.js";
import type { CredentialStorageMode } from "../../shared/credentialStorageSettings.js";
import type {
  McpTunnelRuntimeApiKeyPersistence,
  StartTunnelInput
} from "../../shared/mcpTunnel.js";
import type { TunnelClientConfig } from "./tunnelClientStore.js";

export type TunnelClientConfigSnapshot = {
  config: TunnelClientConfig;
  runtimeApiKey: string | null;
  sessionRuntimeApiKey: string | null;
};

export function createTunnelClientConfigController(options: {
  read(): Promise<TunnelClientConfig>;
  write(config: TunnelClientConfig): Promise<void>;
  storage(): DesktopCredentialStorage;
  mode(): CredentialStorageMode;
  storageForMode(mode: CredentialStorageMode): DesktopCredentialStorage | null;
}) {
  let committed: TunnelClientConfigSnapshot | null = null;
  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(command: () => Promise<T>): Promise<T> => {
    const result = tail.then(command);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const ciphertext = (config: TunnelClientConfig) =>
    config.encryptedRuntimeApiKeys?.[options.mode()] ??
    (options.mode() === "system" ? config.encryptedRuntimeApiKey : null);
  const restore = (config: TunnelClientConfig): string | null => {
    const value = ciphertext(config);
    if (!value || !options.storage().isEncryptionAvailable()) return null;
    try {
      return options.storage().decryptString(Buffer.from(value, "base64")).trim() || null;
    } catch {
      // Unrestorable saved credentials remain missing, as with legacy secure storage.
      return null;
    }
  };
  const load = async (): Promise<TunnelClientConfigSnapshot> => {
    if (!committed) {
      const config = await options.read();
      committed = { config, runtimeApiKey: restore(config), sessionRuntimeApiKey: null };
    }
    return committed;
  };
  const persisted = (state: TunnelClientConfigSnapshot): boolean =>
    Boolean(
      state.runtimeApiKey && ciphertext(state.config) && options.storage().isEncryptionAvailable()
    );
  const sessionKey = (state: TunnelClientConfigSnapshot): string | null =>
    state.sessionRuntimeApiKey ??
    (options.storage().isEncryptionAvailable() ? null : state.runtimeApiKey);
  const persistence = (state: TunnelClientConfigSnapshot): McpTunnelRuntimeApiKeyPersistence =>
    persisted(state) ? "persisted" : sessionKey(state) ? "session-only" : "missing";

  const update = (command: (current: TunnelClientConfigSnapshot) => TunnelClientConfigSnapshot) =>
    enqueue(async () => {
      const previous = await load();
      const config = await options.read();
      const current = {
        config,
        runtimeApiKey:
          ciphertext(config) === ciphertext(previous.config)
            ? previous.runtimeApiKey
            : restore(config),
        sessionRuntimeApiKey: previous.sessionRuntimeApiKey
      };
      const candidate = command(current);
      if (candidate.config !== config) await options.write(candidate.config);
      committed = candidate;
      return candidate;
    });

  return {
    get current() {
      return committed;
    },
    read: () => enqueue(load),
    update,
    persisted,
    sessionKey,
    persistence,
    prepareStart: (input: StartTunnelInput) =>
      update((current) => {
        const tunnelId = input.tunnelId?.trim() || current.config.tunnelId;
        const requestedKey = input.runtimeApiKey?.trim() || null;
        const key =
          requestedKey ?? (persisted(current) ? current.runtimeApiKey : sessionKey(current));
        if (!tunnelId) throw new Error("tunnel_id is required.");
        if (!key) throw new Error("Runtime API key is required.");
        if (!requestedKey) return { ...current, config: { ...current.config, tunnelId } };
        const mode = options.mode();
        const keys = { ...(current.config.encryptedRuntimeApiKeys ?? {}) };
        if (options.storage().isEncryptionAvailable()) {
          const otherMode = mode === "application" ? "system" : "application";
          const otherCiphertext =
            keys[otherMode] ??
            (otherMode === "system" ? current.config.encryptedRuntimeApiKey : null);
          keys[mode] = options.storage().encryptString(key).toString("base64");
          if (otherCiphertext) {
            const otherStorage = options.storageForMode(otherMode);
            if (otherStorage?.isEncryptionAvailable()) {
              keys[otherMode] = otherStorage.encryptString(key).toString("base64");
            } else {
              delete keys[otherMode];
            }
          }
          return {
            config: {
              ...current.config,
              tunnelId,
              encryptedRuntimeApiKeys: keys,
              encryptedRuntimeApiKey: keys.system ?? null
            },
            runtimeApiKey: key,
            sessionRuntimeApiKey: null
          };
        }
        // A session-only replacement cannot leave a persisted older representation.
        return {
          config: {
            ...current.config,
            tunnelId,
            encryptedRuntimeApiKeys: {},
            encryptedRuntimeApiKey: null,
            autoStart: false
          },
          runtimeApiKey: null,
          sessionRuntimeApiKey: key
        };
      })
  };
}
