import { ipcMain } from "electron";
import {
  credentialStorageConfigureInputSchema,
  credentialStorageSettingsInvokeChannels,
  type CredentialStorageMode,
  type CredentialStorageSettingsStatus
} from "../../shared/credentialStorageSettings.js";
import type { CredentialStoragePreferenceStore } from "./credentialStoragePreferenceStore.js";
import type { CredentialStorageMigrationReceipt } from "./credentialStorageMigration.js";

type CredentialStorageMigrationPort = {
  migrate(targetMode: CredentialStorageMode): Promise<CredentialStorageMigrationReceipt>;
};

export function registerCredentialStorageSettingsHandlers(options: {
  store: CredentialStoragePreferenceStore;
  activeMode: CredentialStorageMode;
  migration: CredentialStorageMigrationPort;
}): void {
  let queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
  const status = async (): Promise<CredentialStorageSettingsStatus> => {
    const configured = await options.store.read();
    return {
      activeMode: options.activeMode,
      configuredMode: configured.mode,
      restartRequired: configured.mode !== options.activeMode
    };
  };

  ipcMain.handle(credentialStorageSettingsInvokeChannels.getStatus, () => enqueue(status));
  ipcMain.handle(credentialStorageSettingsInvokeChannels.configure, (_event, input: unknown) =>
    enqueue(async () => {
      const parsed = credentialStorageConfigureInputSchema.parse(input);
      const configured = await options.store.read();
      if (configured.mode === parsed.mode) return status();
      const receipt =
        parsed.mode === options.activeMode ? null : await options.migration.migrate(parsed.mode);
      try {
        await options.store.write(parsed);
      } catch (error) {
        try {
          await receipt?.rollbackSharedFiles();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Credential mode change and rollback failed."
          );
        }
        throw error;
      }
      return status();
    })
  );
}
