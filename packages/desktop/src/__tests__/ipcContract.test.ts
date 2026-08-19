import { cloneDesktopGraphEditResult, type GraphEditResult } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { appUpdateChangedChannel, appUpdateInvokeChannels } from "../shared/appUpdate";
import { desktopSettingsInvokeChannels } from "../shared/desktopSettings";
import { credentialStorageSettingsInvokeChannels } from "../shared/credentialStorageSettings";
import {
  autoRunChangedChannel,
  desktopBridgeInvokeChannels,
  packageFileChangedChannel,
  runtimeStateChangedChannel
} from "../shared/ipcChannels";
import {
  collaborationCurrentSelectionInputSchema,
  collaborationCanvasLiveSyncSignalChannel,
  collaborationInvokeChannels,
  localCollaborationRegistrationInputSchema,
  collaborationObserverSignalChannel,
  collaborationPresenceSignalChannel,
  collaborationStatusChangedChannel
} from "../shared/collaboration";
import { mcpTunnelChangedChannel, mcpTunnelInvokeChannels } from "../shared/mcpTunnel";
import { operatorControlInvokeChannels } from "../shared/operatorControl";
import { windowAppearanceInvokeChannels } from "../shared/windowAppearance";

describe("desktop IPC contract", () => {
  it("accepts one explicit local profile as a registration target", () => {
    expect(
      localCollaborationRegistrationInputSchema.parse({
        profileId: "planweave-local-project-1"
      })
    ).toEqual({ profileId: "planweave-local-project-1" });
    expect(
      localCollaborationRegistrationInputSchema.safeParse({ profileId: "remote-profile" }).success
    ).toBe(false);
    expect(
      localCollaborationRegistrationInputSchema.safeParse({
        profileId: "planweave-local-project-1",
        selection: { projectId: "project-1", canvasId: "canvas-1" }
      }).success
    ).toBe(false);
  });

  it("uses stable, unique invoke channel names", () => {
    const entries = Object.entries(desktopBridgeInvokeChannels);
    const channels = entries.map(([, channel]) => channel);

    for (const [method, channel] of entries) {
      expect(channel).toBe(`planweave:${method}`);
    }
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("keeps subscription event channels outside the invoke channel registry", () => {
    expect(packageFileChangedChannel).toBe("planweave:packageFileChanged");
    expect(runtimeStateChangedChannel).toBe("planweave:runtimeStateChanged");
    expect(autoRunChangedChannel).toBe("planweave:autoRunChanged");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(packageFileChangedChannel);
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(runtimeStateChangedChannel);
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(autoRunChangedChannel);
  });

  it("keeps window appearance channels outside the runtime bridge registry", () => {
    expect(windowAppearanceInvokeChannels.getWindowMaterialCapabilities).toBe(
      "planweave-window:getWindowMaterialCapabilities"
    );
    expect(windowAppearanceInvokeChannels.setWindowMaterial).toBe(
      "planweave-window:setWindowMaterial"
    );
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(
      windowAppearanceInvokeChannels.getWindowMaterialCapabilities
    );
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(
      windowAppearanceInvokeChannels.setWindowMaterial
    );
  });

  it("keeps app update channels outside the runtime bridge registry", () => {
    expect(appUpdateInvokeChannels.getAppUpdateState).toBe(
      "planweave-app-update:getAppUpdateState"
    );
    expect(appUpdateInvokeChannels.checkForAppUpdate).toBe(
      "planweave-app-update:checkForAppUpdate"
    );
    expect(appUpdateInvokeChannels.downloadAppUpdate).toBe(
      "planweave-app-update:downloadAppUpdate"
    );
    expect(appUpdateInvokeChannels.installAppUpdate).toBe("planweave-app-update:installAppUpdate");
    expect(appUpdateChangedChannel).toBe("planweave-app-update:changed");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(appUpdateChangedChannel);
    for (const channel of Object.values(appUpdateInvokeChannels)) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
  });

  it("keeps desktop settings channels outside the runtime bridge registry", () => {
    expect(desktopSettingsInvokeChannels.getDesktopSettings).toBe(
      "planweave-desktop-settings:getDesktopSettings"
    );
    expect(desktopSettingsInvokeChannels.saveDesktopSettings).toBe(
      "planweave-desktop-settings:saveDesktopSettings"
    );
    expect(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings).toBe(
      "planweave-desktop-settings:migrateLegacyDesktopSettings"
    );
    for (const channel of Object.values(desktopSettingsInvokeChannels)) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
  });

  it("keeps credential storage settings channels unique and outside the runtime registry", () => {
    const channels = Object.values(credentialStorageSettingsInvokeChannels);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels).toEqual([
      "planweave-credential-storage:getStatus",
      "planweave-credential-storage:configure"
    ]);
    for (const channel of channels) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
  });

  it("keeps MCP tunnel channels outside the runtime bridge registry", () => {
    expect(mcpTunnelInvokeChannels.getMcpTunnelStatus).toBe("planweave-mcp-tunnel:getStatus");
    expect(mcpTunnelInvokeChannels.downloadTunnelClient).toBe(
      "planweave-mcp-tunnel:downloadTunnelClient"
    );
    expect(mcpTunnelInvokeChannels.setTunnelClientPath).toBe(
      "planweave-mcp-tunnel:setTunnelClientPath"
    );
    expect(mcpTunnelInvokeChannels.setTunnelAutoStart).toBe(
      "planweave-mcp-tunnel:setTunnelAutoStart"
    );
    expect(mcpTunnelInvokeChannels.startLocalMcp).toBe("planweave-mcp-tunnel:startLocalMcp");
    expect(mcpTunnelInvokeChannels.stopLocalMcp).toBe("planweave-mcp-tunnel:stopLocalMcp");
    expect(mcpTunnelInvokeChannels.startTunnel).toBe("planweave-mcp-tunnel:startTunnel");
    expect(mcpTunnelInvokeChannels.stopTunnel).toBe("planweave-mcp-tunnel:stopTunnel");
    expect(mcpTunnelChangedChannel).toBe("planweave-mcp-tunnel:changed");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(mcpTunnelChangedChannel);
    for (const channel of Object.values(mcpTunnelInvokeChannels)) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
  });

  it("keeps Host bootstrap clipboard handoff outside the runtime bridge registry", () => {
    expect(operatorControlInvokeChannels.copyHostBootstrapHandoff).toBe(
      "planweave-operator:copyHostBootstrapHandoff"
    );
    expect(operatorControlInvokeChannels.copyMemberSetupCode).toBe(
      "planweave-operator:copyMemberSetupCode"
    );
    expect(operatorControlInvokeChannels.registerLocalAgentHost).toBe(
      "planweave-operator:registerLocalAgentHost"
    );
    expect(operatorControlInvokeChannels.enrollLocalAgentHost).toBe(
      "planweave-operator:enrollLocalAgentHost"
    );
    expect(operatorControlInvokeChannels.replayOwnerFleetRemoteOperationEvents).toBe(
      "planweave-operator:replayOwnerFleetRemoteOperationEvents"
    );
    expect(Object.values(operatorControlInvokeChannels)).not.toContain(
      "planweave-operator:createEnrollmentGrant"
    );
    for (const channel of Object.values(operatorControlInvokeChannels)) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
  });

  it("keeps collaboration channels outside the runtime bridge registry", () => {
    expect(collaborationInvokeChannels.getCollaborationStatus).toBe(
      "planweave-collaboration:getStatus"
    );
    expect(collaborationInvokeChannels.upsertCollaborationProfile).toBe(
      "planweave-collaboration:upsertProfile"
    );
    expect(collaborationInvokeChannels.removeCollaborationProfile).toBe(
      "planweave-collaboration:removeProfile"
    );
    expect(collaborationInvokeChannels.setActiveCollaborationProfile).toBe(
      "planweave-collaboration:setActiveProfile"
    );
    expect(collaborationInvokeChannels.clearActiveCollaborationProfile).toBe(
      "planweave-collaboration:clearActiveProfile"
    );
    expect(collaborationInvokeChannels.importDeviceCredential).toBe(
      "planweave-collaboration:importDeviceCredential"
    );
    expect(collaborationInvokeChannels.clearDeviceCredential).toBe(
      "planweave-collaboration:clearDeviceCredential"
    );
    expect(collaborationInvokeChannels.bootstrapCollaborationOwner).toBe(
      "planweave-collaboration:bootstrapOwner"
    );
    expect(collaborationInvokeChannels.consumeCollaborationInvitation).toBe(
      "planweave-collaboration:consumeInvitation"
    );
    expect(collaborationInvokeChannels.connectCollaborationSession).toBe(
      "planweave-collaboration:connectSession"
    );
    expect(collaborationInvokeChannels.disconnectCollaborationSession).toBe(
      "planweave-collaboration:disconnectSession"
    );
    expect(collaborationInvokeChannels.flushCollaborationCanvasReplicaMaterialization).toBe(
      "planweave-collaboration:flushCanvasReplicaMaterialization"
    );
    expect(collaborationInvokeChannels.redeemCollaborationSetupCode).toBe(
      "planweave-collaboration:redeemSetupCode"
    );
    expect(collaborationInvokeChannels.connectExistingServerByOrigin).toBe(
      "planweave-collaboration:connectExistingServerByOrigin"
    );
    expect(collaborationInvokeChannels.getActiveWorkspaceConnection).toBe(
      "planweave-collaboration:getActiveWorkspaceConnection"
    );
    expect(collaborationInvokeChannels.listRememberedServerConnections).toBe(
      "planweave-collaboration:listRememberedServerConnections"
    );
    expect(collaborationInvokeChannels.forgetRememberedServerConnection).toBe(
      "planweave-collaboration:forgetRememberedServerConnection"
    );
    expect(collaborationInvokeChannels.listWorkspacePicker).toBe(
      "planweave-collaboration:listWorkspacePicker"
    );
    expect(collaborationInvokeChannels.selectWorkspaceConnection).toBe(
      "planweave-collaboration:selectWorkspaceConnection"
    );
    expect(collaborationInvokeChannels.connectWorkspaceConnection).toBe(
      "planweave-collaboration:connectWorkspaceConnection"
    );
    expect(collaborationInvokeChannels.disconnectWorkspaceConnection).toBe(
      "planweave-collaboration:disconnectWorkspaceConnection"
    );
    expect(collaborationInvokeChannels.retryWorkspaceConnection).toBe(
      "planweave-collaboration:retryWorkspaceConnection"
    );
    expect(collaborationInvokeChannels.getCurrentCanvasAccess).toBe(
      "planweave-collaboration:getCurrentCanvasAccess"
    );
    expect(collaborationInvokeChannels.mutateCurrentCanvasAccess).toBe(
      "planweave-collaboration:mutateCurrentCanvasAccess"
    );
    expect(collaborationInvokeChannels.setCollaborationCurrentSelection).toBe(
      "planweave-collaboration:setCurrentSelection"
    );
    expect(collaborationInvokeChannels.setLocalCollaborationLanSharing).toBe(
      "planweave-collaboration:setLocalLanSharing"
    );
    expect(collaborationInvokeChannels.clearCollaborationCurrentSelection).toBe(
      "planweave-collaboration:clearCurrentSelection"
    );
    expect(collaborationInvokeChannels.getLocalCollaborationServerStatus).toBe(
      "planweave-collaboration:getLocalServerStatus"
    );
    expect(collaborationInvokeChannels.getLocalCollaborationScopeCatalog).toBe(
      "planweave-collaboration:getLocalScopeCatalog"
    );
    expect(collaborationInvokeChannels.setLocalCollaborationTrustedScopes).toBe(
      "planweave-collaboration:setLocalTrustedScopes"
    );
    expect(collaborationInvokeChannels.startLocalCollaborationServer).toBe(
      "planweave-collaboration:startLocalServer"
    );
    expect(collaborationInvokeChannels.stopLocalCollaborationServer).toBe(
      "planweave-collaboration:stopLocalServer"
    );
    expect(collaborationInvokeChannels.listLocalCollaborationTrustedScopes).toBe(
      "planweave-collaboration:listLocalTrustedScopes"
    );
    expect(collaborationInvokeChannels.registerLocalCollaborationCurrentProject).toBe(
      "planweave-collaboration:registerLocalCurrentProject"
    );
    expect(collaborationInvokeChannels.listCollaborationMembers).toBe(
      "planweave-collaboration:listMembers"
    );
    expect(collaborationInvokeChannels.updateOwnCollaborationDisplayName).toBe(
      "planweave-collaboration:updateOwnDisplayName"
    );
    expect(collaborationInvokeChannels.createCollaborationInvitation).toBe(
      "planweave-collaboration:createInvitation"
    );
    expect(collaborationInvokeChannels.createCollaborationInvitationHandoff).toBe(
      "planweave-collaboration:createInvitationHandoff"
    );
    expect(collaborationInvokeChannels.getCollaborationInvitationHandoff).toBe(
      "planweave-collaboration:getInvitationHandoff"
    );
    expect(collaborationInvokeChannels.getDesktopServerExposure).toBe(
      "planweave-collaboration:getDesktopServerExposure"
    );
    expect(collaborationInvokeChannels.setDesktopServerExposureMode).toBe(
      "planweave-collaboration:setDesktopServerExposureMode"
    );
    expect(collaborationInvokeChannels.listServerDataExportSources).toBe(
      "planweave-collaboration:listServerDataExportSources"
    );
    expect(collaborationInvokeChannels.exportServerDataArchive).toBe(
      "planweave-collaboration:exportServerDataArchive"
    );
    expect(collaborationInvokeChannels.restoreServerDataArchive).toBe(
      "planweave-collaboration:restoreServerDataArchive"
    );
    expect(collaborationInvokeChannels.revokeCollaborationInvitation).toBe(
      "planweave-collaboration:revokeInvitation"
    );
    expect(collaborationInvokeChannels.revokeCollaborationInvitations).toBe(
      "planweave-collaboration:revokeInvitations"
    );
    expect(collaborationInvokeChannels.removeCollaborationMember).toBe(
      "planweave-collaboration:removeMember"
    );
    expect(collaborationInvokeChannels.promoteCollaborationOwner).toBe(
      "planweave-collaboration:promoteOwner"
    );
    expect(collaborationInvokeChannels.demoteCollaborationOwner).toBe(
      "planweave-collaboration:demoteOwner"
    );
    expect(collaborationInvokeChannels.revokeCollaborationDevice).toBe(
      "planweave-collaboration:revokeDevice"
    );
    expect(collaborationInvokeChannels.listCollaborationAssignments).toBe(
      "planweave-collaboration:listAssignments"
    );
    expect(collaborationInvokeChannels.listCollaborationComments).toBe(
      "planweave-collaboration:listComments"
    );
    expect(collaborationInvokeChannels.listCollaborationActivity).toBe(
      "planweave-collaboration:listActivity"
    );
    expect(collaborationInvokeChannels.updateCollaborationAssignment).toBe(
      "planweave-collaboration:updateAssignment"
    );
    expect(collaborationInvokeChannels.createCollaborationPendingAttachment).toBe(
      "planweave-collaboration:createPendingAttachment"
    );
    expect(collaborationInvokeChannels.uploadCollaborationPendingAttachment).toBe(
      "planweave-collaboration:uploadPendingAttachment"
    );
    expect(collaborationInvokeChannels.finalizeCollaborationPendingAttachment).toBe(
      "planweave-collaboration:finalizePendingAttachment"
    );
    expect(collaborationInvokeChannels.readCollaborationCommentAttachment).toBe(
      "planweave-collaboration:readCommentAttachment"
    );
    expect(collaborationInvokeChannels.dispatchCollaborationRemoteOperation).toBe(
      "planweave-collaboration:dispatchRemoteOperation"
    );
    expect(collaborationInvokeChannels.observeCollaborationRemoteOperation).toBe(
      "planweave-collaboration:observeRemoteOperation"
    );
    expect(collaborationInvokeChannels.executeCollaborationRemoteOperationAction).toBe(
      "planweave-collaboration:executeRemoteOperationAction"
    );
    expect(collaborationInvokeChannels.replayCollaborationRemoteOperationEvents).toBe(
      "planweave-collaboration:replayRemoteOperationEvents"
    );
    expect(collaborationInvokeChannels.listCollaborationRemoteOperationInteractions).toBe(
      "planweave-collaboration:listRemoteOperationInteractions"
    );
    expect(collaborationInvokeChannels.settleCollaborationRemoteOperationInteraction).toBe(
      "planweave-collaboration:settleRemoteOperationInteraction"
    );
    expect(collaborationStatusChangedChannel).toBe("planweave-collaboration:statusChanged");
    expect(collaborationObserverSignalChannel).toBe("planweave-collaboration:observerSignal");
    expect(collaborationPresenceSignalChannel).toBe("planweave-collaboration:presenceSignal");
    expect(collaborationCanvasLiveSyncSignalChannel).toBe(
      "planweave-collaboration:canvasLiveSyncSignal"
    );
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(
      collaborationStatusChangedChannel
    );
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(
      collaborationObserverSignalChannel
    );
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(
      collaborationPresenceSignalChannel
    );
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(
      collaborationCanvasLiveSyncSignalChannel
    );
    expect(Object.values(collaborationInvokeChannels)).not.toContain(
      collaborationObserverSignalChannel
    );
    expect(Object.values(collaborationInvokeChannels)).not.toContain(
      collaborationPresenceSignalChannel
    );
    expect(Object.values(collaborationInvokeChannels)).not.toContain(
      collaborationCanvasLiveSyncSignalChannel
    );
    for (const channel of Object.values(collaborationInvokeChannels)) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
    expect(new Set(Object.values(collaborationInvokeChannels)).size).toBe(
      Object.values(collaborationInvokeChannels).length
    );
  });

  it("keeps local collaboration selection opaque at the renderer boundary", () => {
    expect(
      collaborationCurrentSelectionInputSchema.parse({
        projectId: "project-1",
        canvasId: "canvas-1"
      })
    ).toEqual({ projectId: "project-1", canvasId: "canvas-1" });
    expect(() =>
      collaborationCurrentSelectionInputSchema.parse({
        projectId: "project-1",
        canvasId: "canvas-1",
        projectRoot: "/private/project"
      })
    ).toThrow();
  });

  it("uses the desktop canvas reference channel for canvas-scoped bridge calls", () => {
    expect(desktopBridgeInvokeChannels.getGraphViewModel).toBe("planweave:getGraphViewModel");
    expect(desktopBridgeInvokeChannels.getTaskWorkspace).toBe("planweave:getTaskWorkspace");
    expect(desktopBridgeInvokeChannels.listTaskWorkspaceRuns).toBe(
      "planweave:listTaskWorkspaceRuns"
    );
    expect(desktopBridgeInvokeChannels.getTaskWorkspaceRunDetail).toBe(
      "planweave:getTaskWorkspaceRunDetail"
    );
    expect(desktopBridgeInvokeChannels.retryTaskWorkspaceRun).toBe(
      "planweave:retryTaskWorkspaceRun"
    );
    expect(desktopBridgeInvokeChannels.getCanvasGraphViewModel).toBe(
      "planweave:getCanvasGraphViewModel"
    );
    expect(desktopBridgeInvokeChannels.getCanvasMapLayout).toBe("planweave:getCanvasMapLayout");
    expect(desktopBridgeInvokeChannels.getDesktopLayout).toBe("planweave:getDesktopLayout");
    expect(desktopBridgeInvokeChannels.applyCanvasLaneLayout).toBe(
      "planweave:applyCanvasLaneLayout"
    );
    expect(desktopBridgeInvokeChannels.getDesktopGraphDiagnostics).toBe(
      "planweave:getDesktopGraphDiagnostics"
    );
    expect(desktopBridgeInvokeChannels.getDesktopProjectSnapshot).toBe(
      "planweave:getDesktopProjectSnapshot"
    );
    expect(desktopBridgeInvokeChannels.getDesktopRuntimeRefresh).toBe(
      "planweave:getDesktopRuntimeRefresh"
    );
    expect(desktopBridgeInvokeChannels.listPendingImportRecoveries).toBe(
      "planweave:listPendingImportRecoveries"
    );
    expect(desktopBridgeInvokeChannels.rollbackPendingImportRecovery).toBe(
      "planweave:rollbackPendingImportRecovery"
    );
    expect(desktopBridgeInvokeChannels.watchPackageFiles).toBe("planweave:watchPackageFiles");
    expect(desktopBridgeInvokeChannels.watchRuntimeState).toBe("planweave:watchRuntimeState");
    expect(desktopBridgeInvokeChannels.unwatchRuntimeState).toBe("planweave:unwatchRuntimeState");
    expect(desktopBridgeInvokeChannels.getTodoGroups).toBe("planweave:getTodoGroups");
  });

  it("strips compiled graph internals from graph edit IPC results", () => {
    const result: GraphEditResult = {
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: [],
      graph: { indexes: "not cloneable over IPC" } as never
    };

    expect(cloneDesktopGraphEditResult(result)).toEqual({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    });
  });
});
