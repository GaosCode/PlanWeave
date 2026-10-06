import { clipboard, type BrowserWindow } from "electron";

export async function runManagementServerSwitchSmoke(
  window: BrowserWindow
): Promise<Record<string, unknown>> {
  const firstOrigin = process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_SERVER_URL;
  const secondOrigin = process.env.PLANWEAVE_DESKTOP_SMOKE_SWITCHED_SERVER_URL;
  const token = process.env.PLANWEAVE_DESKTOP_SMOKE_OPERATOR_TOKEN;
  const projectId = process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_PROJECT_ID;
  if (!firstOrigin || !secondOrigin || !token || !projectId) {
    throw new Error("Server switch smoke fixture configuration is incomplete.");
  }
  const priorClipboardText = clipboard.readText();
  clipboard.writeText(token);
  try {
    return (await window.webContents.executeJavaScript(`
      (async () => {
        const firstOrigin = ${JSON.stringify(firstOrigin)};
        const secondOrigin = ${JSON.stringify(secondOrigin)};
        const collaboration = window.planweaveCollaboration;
        const operator = window.planweaveOperatorControl;
        if (!collaboration || !operator) throw new Error("Server switch typed bridges are unavailable.");
        const waitFor = async (predicate, label) => {
          for (let attempt = 0; attempt < 160; attempt += 1) {
            const value = await predicate();
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Timed out waiting for " + label);
        };
        const secondProfileId = "desktop-smoke-second-server";
        await collaboration.upsertCollaborationProfile({
          profileId: secondProfileId,
          displayName: "Desktop smoke second Server",
          serverBaseUrl: secondOrigin,
          projectId: ${JSON.stringify(projectId)},
          allowInsecureTransport: true,
          endpoint: {
            topology: "loopback_http",
            serverOrigin: secondOrigin,
            allowedClientOrigins: [secondOrigin],
            tlsTrust: "not_applicable"
          }
        });
        await collaboration.bootstrapCollaborationOwner({
          profileId: secondProfileId,
          request: { displayName: "Desktop smoke second owner" }
        });
        await collaboration.connectCollaborationSession({ profileId: secondProfileId });
        await operator.upsertOperatorProfile({
          profileId: secondProfileId,
          displayName: "Desktop smoke second management",
          serverBaseUrl: secondOrigin,
          allowInsecureTransport: true,
          operatorId: "desktop-smoke-admin"
        });
        await operator.importOperatorCredential({ profileId: secondProfileId, verifyBeforeSave: true });
        const secondAuthorization = await waitFor(async () => {
          const view = await operator.getManagementAuthorization({ profileId: secondProfileId });
          return view.authorization && view.deviceId && view.devices?.some((device) =>
            device.deviceId === view.deviceId && !device.revokedAt
          ) ? view : null;
        }, "second Server-backed management authorization");
        const secondDevice = secondAuthorization.devices.find((device) =>
          device.deviceId === secondAuthorization.deviceId
        );
        document.querySelector('[data-testid="sidebar-settings"]')?.click();
        await waitFor(() => document.querySelector('[data-testid="settings-nav-connections"]'), "Connections navigation");
        document.querySelector('[data-testid="settings-nav-connections"]')?.click();
        await waitFor(() => document.querySelector('[data-testid="settings-connections-section"]'), "Connections settings");
        document.querySelector('[data-testid="settings-connections-tab-server"]')?.click();
        const rowFor = (origin) => [...document.querySelectorAll('[data-testid="server-connection-row"]')]
          .find((row) => row.textContent?.includes(origin));
        await waitFor(() => rowFor(firstOrigin) && rowFor(secondOrigin), "both isolated Server rows");
        const openDetails = async (origin) => {
          const row = rowFor(origin);
          if (!row) throw new Error("Missing Server row for management details.");
          const actions = row.querySelector('button[aria-haspopup="menu"]');
          if (!(actions instanceof HTMLButtonElement)) throw new Error("Missing Server actions menu.");
          actions.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            pointerType: 'mouse',
            button: 0
          }));
          let detail;
          try {
            detail = await waitFor(() => {
              const menuId = actions.getAttribute('aria-controls');
              const menu = menuId ? document.getElementById(menuId) : null;
              const item = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])]
                .find((item) => /Manage permissions|管理权限/.test(item.textContent ?? ""));
              return item && item.getAttribute('aria-disabled') !== 'true' &&
                !item.hasAttribute('data-disabled') ? item : null;
            }, "Server management details menu");
          } catch (error) {
            throw new Error(String(error) + ": " + JSON.stringify({
              controls: actions.getAttribute('aria-controls'),
              buttons: [...row.querySelectorAll('button')].map((button) => ({
                label: button.getAttribute('aria-label'),
                popup: button.getAttribute('aria-haspopup'),
                expanded: button.getAttribute('aria-expanded')
              })),
              menus: [...document.querySelectorAll('[role="menuitem"]')].map((item) => ({
                label: item.textContent?.trim(),
                disabled: item.getAttribute('aria-disabled'),
                connected: item.isConnected
              }))
            }));
          }
          detail.click();
          let identity;
          try {
            identity = await waitFor(() => [...document.querySelectorAll('[data-testid="management-server-identity"]')]
              .find((element) => element.textContent?.includes(origin)), "management Server identity for " + origin);
          } catch (error) {
            throw new Error(String(error) + ": " + JSON.stringify({
              requestedOrigin: origin,
              selectedRow: row.textContent?.slice(0, 180),
              selectedMenuItem: detail.textContent?.trim(),
              selectedMenuItemDisabled: detail.getAttribute('aria-disabled'),
              selectedMenuItemConnected: detail.isConnected,
              serverRows: [...document.querySelectorAll('[data-testid="server-connection-row"]')]
                .map((element) => element.textContent?.slice(0, 180)),
              identities: [...document.querySelectorAll('[data-testid="management-server-identity"]')]
                .map((element) => element.textContent?.slice(0, 180)),
              openDialogs: document.querySelectorAll('[role="dialog"]').length
            }));
          }
          const dialog = identity.closest('[role="dialog"]');
          if (!dialog) throw new Error("Management dialog is missing.");
          return dialog;
        };
        const closeDetails = async (dialog) => {
          dialog.querySelector('[data-testid="management-dialog-close"]')?.click();
          await waitFor(() => !dialog.isConnected, "management dialog to close");
        };
        const secondDialog = await openDetails(secondOrigin);
        await waitFor(() => secondDialog.textContent?.includes(secondDevice.deviceName), "second Server device in UI");
        await closeDetails(secondDialog);
        const firstDialog = await openDetails(firstOrigin);
        if (firstDialog.textContent?.includes(secondDevice.deviceName)) {
          throw new Error("Second Server device leaked into cleared first Server management view.");
        }
        await waitFor(() => firstDialog.querySelector('[role="alert"]'), "first Server recovery state");
        await closeDetails(firstDialog);
        const reopenedSecond = await openDetails(secondOrigin);
        await waitFor(() => reopenedSecond.textContent?.includes(secondDevice.deviceName), "second Server device after A to B switch");
        await closeDetails(reopenedSecond);
        document.querySelector('[data-testid="settings-back-to-app"]')?.click();
        await collaboration.selectWorkspaceConnection({ profileId: "desktop-smoke-owner" });
        await collaboration.connectCollaborationSession({ profileId: "desktop-smoke-owner" });
        await operator.setActiveOperatorProfile({ profileId: "desktop-smoke-management" });
        const restored = await collaboration.getCollaborationStatus();
        if (restored.workspaceConnection.profile?.serverBaseUrl !== firstOrigin ||
          !["connected", "ready"].includes(restored.session.phase)) {
          throw new Error("First Server collaboration state was not restored after switch smoke.");
        }
        return {
          twoServerRowsVisible: true,
          secondServerAuthorization: true,
          secondDeviceVisible: true,
          clearedFirstServerDidNotShowSecondDevice: true,
          secondDeviceVisibleAfterSwitchBack: true,
          firstServerCollaborationRestored: true,
          firstServerCredentialRemainsCleared: true
        };
      })()
    `)) as Record<string, unknown>;
  } finally {
    clipboard.writeText(priorClipboardText);
  }
}
