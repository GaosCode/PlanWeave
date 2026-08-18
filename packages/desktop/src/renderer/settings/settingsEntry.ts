export type SettingsConnectionsTab = "overview" | "devices" | "server";

let pendingConnectionsTab: SettingsConnectionsTab | null = null;

/** Queue the Connections tab shown the next time Settings mounts. */
export function queueSettingsConnectionsTab(tab: SettingsConnectionsTab): void {
  pendingConnectionsTab = tab;
}

export function peekSettingsConnectionsTab(): SettingsConnectionsTab | null {
  return pendingConnectionsTab;
}

export function consumeSettingsConnectionsTab(): SettingsConnectionsTab | null {
  const tab = pendingConnectionsTab;
  pendingConnectionsTab = null;
  return tab;
}
