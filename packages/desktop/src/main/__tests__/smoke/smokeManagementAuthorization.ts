import { clipboard, type BrowserWindow } from "electron";

export async function runManagementAuthorizationSmoke(
  window: BrowserWindow
): Promise<Record<string, unknown>> {
  const serverBaseUrl = process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_SERVER_URL;
  const operatorToken = process.env.PLANWEAVE_DESKTOP_SMOKE_OPERATOR_TOKEN;
  if (!serverBaseUrl || !operatorToken) {
    throw new Error("Management smoke fixture configuration is incomplete.");
  }
  const priorClipboardText = clipboard.readText();
  clipboard.writeText(operatorToken);
  try {
    return (await window.webContents.executeJavaScript(`
      (async () => {
        const bridge = window.planweaveOperatorControl;
        if (!bridge) throw new Error("Typed operator bridge is unavailable.");
        const waitFor = async (predicate, label, attempts = 160) => {
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            const value = await predicate();
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Timed out waiting for " + label);
        };
        const profileId = "desktop-smoke-management";
        await bridge.upsertOperatorProfile({
          profileId,
          displayName: "Desktop smoke management",
          serverBaseUrl: ${JSON.stringify(serverBaseUrl)},
          allowInsecureTransport: true,
          operatorId: "desktop-smoke-admin"
        });
        document.querySelector('[data-testid="sidebar-settings"]')?.click();
        await waitFor(() => document.querySelector('[data-testid="settings-nav-connections"]'), "Connections navigation");
        document.querySelector('[data-testid="settings-nav-connections"]')?.click();
        await waitFor(() => document.querySelector('[data-testid="settings-connections-section"]'), "Connections settings");
        document.querySelector('[data-testid="settings-connections-tab-server"]')?.click();
        const findRow = () =>
          [...document.querySelectorAll('[data-testid="server-connection-row"]')]
            .find((element) => element.textContent?.includes(${JSON.stringify(serverBaseUrl)}));
        const row = await waitFor(findRow, "remembered Server row");
        // The row disables "Restore access" while its authorization check is in
        // flight, so a click issued too early is dropped without any signal.
        const restoreControl = () =>
          [...(findRow() ?? row).querySelectorAll("button")].find(
            (button) =>
              (button.dataset.testid === "server-management-restore" ||
                /Restore|恢复/.test(button.textContent ?? "")) &&
              !button.disabled
          );
        const managementDiagnostics = async () => {
          const currentRow = findRow() ?? row;
          let status = null;
          try {
            status = await bridge.getOperatorControlStatus();
          } catch {
            status = null;
          }
          return {
            rowConnected: currentRow.isConnected,
            row: currentRow.textContent?.slice(0, 200) ?? null,
            buttons: [...currentRow.querySelectorAll("button")].map((button) => ({
              label: button.textContent?.trim() ?? null,
              disabled: button.disabled,
              connected: button.isConnected
            })),
            dialogs: document.querySelectorAll('[role="dialog"]').length,
            identities: [...document.querySelectorAll('[data-testid="management-server-identity"]')]
              .map((element) => element.textContent?.slice(0, 200) ?? null),
            alerts: [...document.querySelectorAll('[role="alert"]')]
              .map((element) => element.textContent?.trim() ?? null),
            operator: status
              ? {
                  activeProfileId: status.activeProfileId,
                  profiles: status.profiles.map((profile) => ({
                    profileId: profile.profileId,
                    serverBaseUrl: profile.serverBaseUrl,
                    hasOperatorCredential: profile.hasOperatorCredential
                  }))
                }
              : null
          };
        };
        const openManagementDialog = async () => {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const control = await waitFor(
              restoreControl,
              "enabled management restore action",
              attempt === 0 ? 80 : 20
            );
            control.click();
            try {
              return await waitFor(
                () => document.querySelector('[data-testid="management-server-identity"]'),
                "management identity",
                40
              );
            } catch {
              // A concurrent status refresh can drop the click; retry the control.
            }
          }
          throw new Error("Timed out waiting for management identity");
        };
        let identity;
        try {
          identity = await openManagementDialog();
        } catch (error) {
          throw new Error(String(error) + ": " + JSON.stringify(await managementDiagnostics()));
        }
        if (!identity.textContent?.includes(${JSON.stringify(serverBaseUrl)})) {
          throw new Error("Management dialog showed a different Server origin.");
        }
        const dialog = identity.closest('[role="dialog"]');
        if (!dialog) throw new Error("Management dialog is unavailable.");
        const advanced = [...dialog.querySelectorAll('summary')].find((summary) =>
          /Advanced|高级/.test(summary.textContent ?? "")
        );
        if (!advanced) throw new Error("Management import section is unavailable.");
        advanced.click();
        const findImportControl = () =>
          [...dialog.querySelectorAll("button")].find(
            (button) => /Import|导入/.test(button.textContent ?? "") && !button.disabled
          );
        const authorizeManagement = async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const action = await waitFor(
              findImportControl,
              "enabled management import action",
              attempt === 0 ? 80 : 20
            );
            action.click();
            try {
              return await waitFor(
                async () => {
                  const view = await bridge.getManagementAuthorization({ profileId });
                  return view.authorization &&
                    view.deviceId &&
                    view.devices?.some(
                      (device) => device.deviceId === view.deviceId && !device.revokedAt
                    )
                    ? view
                    : null;
                },
                "Server-backed management authorization",
                60
              );
            } catch {
              // The click is dropped while the row re-checks authorization.
            }
          }
          throw new Error("Timed out waiting for Server-backed management authorization");
        };
        let authorization;
        try {
          authorization = await authorizeManagement();
        } catch (error) {
          throw new Error(String(error) + ": " + JSON.stringify(await managementDiagnostics()));
        }
        await waitFor(
          () => dialog.textContent?.includes(authorization.devices.find((device) =>
            device.deviceId === authorization.deviceId
          ).deviceName),
          "remembered device in Chromium"
        );
        const serverDeviceCount = authorization.devices.filter((device) => !device.revokedAt).length;
        const statusAfterImport = await bridge.getOperatorControlStatus();
        if (!statusAfterImport.profiles.find((profile) => profile.profileId === profileId)?.hasOperatorCredential) {
          throw new Error("Operator credential was not persisted in isolated Desktop status.");
        }
        await bridge.clearOperatorCredential({ profileId });
        const statusAfterClear = await bridge.getOperatorControlStatus();
        if (statusAfterClear.profiles.find((profile) => profile.profileId === profileId)?.hasOperatorCredential) {
          throw new Error("Typed IPC did not clear the isolated operator credential.");
        }
        try {
          await waitFor(
            () => !dialog.textContent?.includes(authorization.devices.find((device) =>
              device.deviceId === authorization.deviceId
            ).deviceName) &&
            dialog.querySelector('[role="alert"]') !== null,
            "old device to disappear from Chromium after credential clear"
          );
        } catch (error) {
          throw new Error(String(error) + ": " + JSON.stringify({
            devicePresent: dialog.textContent?.includes(authorization.devices.find((device) =>
              device.deviceId === authorization.deviceId
            ).deviceName),
            buttons: [...dialog.querySelectorAll('button')].map((button) => button.textContent?.trim()),
            alerts: [...dialog.querySelectorAll('[role="alert"]')].map((element) => element.textContent?.trim())
          }));
        }
        dialog.querySelector('[data-testid="management-dialog-close"]')?.click();
        document.querySelector('[data-testid="settings-back-to-app"]')?.click();
        return {
          profileBoundToServer: true,
          importTriggeredThroughUi: true,
          serverAuthorization: true,
          serverDeviceCount,
          deviceVisibleBeforeClear: true,
          credentialClearedThroughTypedIpc: true,
          oldDeviceHiddenAfterClear: true,
          serverDeviceRevoked: false
        };
      })()
    `)) as Record<string, unknown>;
  } finally {
    clipboard.writeText(priorClipboardText);
  }
}
