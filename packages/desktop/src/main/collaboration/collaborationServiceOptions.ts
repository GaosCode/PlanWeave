import type { CollaborationClientOptions } from "./CollaborationClient.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import type { CollaborationSafeStoragePort } from "./collaborationCredentialVault.js";
import type { CollaborationProfileStorePaths } from "./collaborationProfileStore.js";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import type { CollaborationProfileStore } from "./collaborationProfileStore.js";
import type { CollaborationInvitationVault } from "./collaborationInvitationVault.js";
import type {
  WorkspaceConnectionProfileStore,
  WorkspaceConnectionProfileStorePaths
} from "./workspaceConnectionProfileStore.js";
import type {
  CollaborationCanvasLiveSyncSignal,
  CollaborationObserverSignal,
  CollaborationPresenceSignal,
  CollaborationStatus
} from "../../shared/collaboration.js";
import type { CollaborationCanvasBindingReplicaSignal } from "../../shared/canvasReplicaIpc.js";

export type CollaborationClientFactory = (
  options: CollaborationClientOptions
) => CollaborationClient;

export type CollaborationServiceOptions = {
  profileStore?: CollaborationProfileStore;
  vault?: CollaborationCredentialVault;
  safeStorage?: CollaborationSafeStoragePort;
  profileStorePaths?: CollaborationProfileStorePaths;
  workspaceProfileStore?: WorkspaceConnectionProfileStore;
  workspaceProfileStorePaths?: WorkspaceConnectionProfileStorePaths;
  exportedIdentityPath?: string;
  credentialsPath?: string;
  invitationVault?: CollaborationInvitationVault;
  invitationsPath?: string;
  createClient?: CollaborationClientFactory;
  request?: typeof fetch;
  clock?: { now(): Date };
  onStatusChange?: (status: CollaborationStatus) => void;
  onObserverSignal?: (signal: CollaborationObserverSignal) => void;
  onPresenceSignal?: (signal: CollaborationPresenceSignal) => void;
  onCanvasLiveSyncSignal?: (signal: CollaborationCanvasLiveSyncSignal) => void;
  onCanvasReplicaSignal?: (signal: CollaborationCanvasBindingReplicaSignal) => void;
  bindLiveOperatorToOrigin?: (serverBaseUrl: string) => Promise<void>;
};
