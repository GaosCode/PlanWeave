export const managementEnCatalog = {
  serverManagementNeedsRecovery: "This computer needs management authorization",
  serverManagementUnavailable:
    "Cannot check management access right now. Check the connection and retry.",
  serverManagementRestoreAccess: "Restore access",
  serverManagementDetails: "Manage access",
  serverManagementDeviceRemembered:
    "This device is remembered. Access credentials refresh automatically, including after time away.",
  serverManagementLegacy: "Device authorization has not been established yet.",
  serverManagementDevices: "Authorized devices",
  serverManagementDevicesHint:
    "Revoking a device immediately removes its management access to this Server.",
  serverManagementThisDevice: "This computer",
  serverManagementLastUsed: "Last refreshed",
  serverManagementRevoke: "Revoke access",
  serverManagementRevokeConfirm:
    "This device will lose management access immediately. Restoring access requires authorization again. Continue?",
  serverManagementDeviceRevoked:
    "This device authorization is invalid or revoked. Restore access to continue.",

  serverManagementAdministrator: "Administrator",
  serverManagementCheckAgain: "Check again",
  serverManagementUpgradeTitle: "Restore management access",
  serverManagementUpgradeLocal:
    "This Server is hosted by this computer. Update Desktop to a version with management authorization, then restart the local Server in Deployment & maintenance.",
  serverManagementUpgradeRemote:
    "This Server runs on another device. Its owner must update the service on that device. Updating Desktop or reconnecting does not upgrade a remote Server.",
  serverManagementUpgradeDeploy:
    "Back up Server data and configuration first. For Docker Compose, use an image with management authorization and recreate the Server container. For source deployments, build a version with this feature and restart the service. Preserve existing data volumes and configuration.",
  serverManagementUpgradeProxy:
    "If the Server already includes this feature, check that the reverse proxy forwards /api/v1/management-authorization/ to the same Server. Both Tailscale and HTTPS require access to this endpoint.",
  serverManagementUpgradeThenAuthorize:
    "Click Check again when ready, then reauthorize. If no valid administrator credential remains, open recovery below, generate a one-time code on the Server and enter it here.",
  serverManagementStandalone: "Standalone CLI (replace the configuration path)",
  serverManagementRecover: "Recover authorization",
  serverManagementFailed: "Management authorization failed. Check the Server and try again.",
  serverManagementImportInvalid: "The clipboard does not contain a valid management credential.",
  serverManagementAuthorityUnavailable:
    "The configured administrator is unavailable. The Server owner must restore its administrator configuration.",
  serverManagementIdentityMissing:
    "This connection has no administrator ID. Complete the management profile before reauthorizing.",
  serverManagementUpgradeRequired:
    "The Server management authorization endpoint is unavailable (HTTP 404). Check the Server version or proxy routing.",
  serverManagementRecoveryInvalid:
    "The recovery code is invalid, expired, already used, or belongs to a different administrator.",
  serverManagementRecoveryRequired:
    "No valid authorization was found. Ask the Server owner for a recovery code to authorize this computer.",
  serverManagementImportHint:
    "For credentials already issued and activated by the administrator. Copy the credential, then import and verify it.",
  serverManagementAdvanced: "Advanced: import a credential",
  serverManagementRecoveryCode: "One-time recovery code",
  serverManagementRecoveryHint:
    "Ask the Server owner to run one of these commands for their deployment (run Docker Compose in the deployment directory). Enter the returned recoveryCode below within 10 minutes. It can authorize one replacement credential. This requires an updated Server and does not change its configuration or restart it.",
  serverManagementRecovery: "Restore with a recovery code",
  serverManagementReauthorizeHint:
    "Uses a valid management credential saved on this computer for the same Server. If none is available, use a recovery code below.",
  serverManagementReauthorize: "Try saved authorization",
  serverManagementWorking: "Authorizing…",
  serverManagementExpires: "Valid until",
  serverManagementAutomatic: "This computer has management access",
  serverManagementChecking: "Checking management authorization…",
  serverManagementAuthorization: "Management access",
  serverManagementAuthorizationHint:
    "Authorize this computer once to manage this Server. Access credentials refresh automatically while the device authorization remains valid.",
  serverManagementImport: "Import from clipboard and verify",
  serverManagementVerified: "Management access verified.",
  serverManagementEmpty:
    "No Server management profile is available. Configure the Server before importing a credential.",
  serverManagementSessionOnly:
    "Authorization is valid but will only be saved for this session. Reauthorize after restarting Desktop.",

  accessCloseDetails: "Close details",
  serverLocalHostingHint:
    "Run collaboration services on this computer for other devices to connect.",
  serverDataLocalScope: "Manage Server data stored on this computer.",
  serverDataExportTitle: "Export local data",
  serverDataExportHint: "Save an archive for backup or transfer to another Server.",
  serverDataImportTitle: "Restore on this computer",
  serverDataImportHint:
    "Choose an archive to import. Replacing existing data requires confirmation.",
  serverDataMigrationDetails: "Migration details",

  accessCancelChanges: "Cancel",
  accessResources: "Resource access",
  accessProjectGrant: "Project authorization",
  accessCanvasGrant: "Canvas authorization",
  accessNoDirectGrant: "No direct grant",
  accessViewChoice: "View",
  accessEditChoice: "Edit",
  accessProjectGrantHint: "Applies to this project’s canvases",
  accessCanvasGrantHint: "Applies only to the selected canvas",
  accessInheritanceHint:
    "Removing a direct grant may still leave access through project authorization or sharing.",
  accessSaved: "Changes saved",
  accessSaveFailed:
    "Some changes could not be saved. Review the current permissions and try again.",
  accessSourceProject: "Project authorization",
  accessSourceCanvas: "Canvas authorization",
  accessSourceShared: "Workspace sharing",
  accessSourceOwner: "Resource owner",
  accessScopeDetails: "Sharing settings",
  workspaceInvitationRequiresServerAccess:
    "Connect this workspace’s Server with invitation permission to copy an invitation.",
  workspaceCopyInvitation: "Copy member invitation",
  workspaceInvitationCopySuccess: "Copied · send it to the other person to join",
  workspaceInvitationCopyHint:
    "Paste it in “Join another workspace”. Canvas authorization is managed separately.",
  workspaceInvitationCopyFailed: "Could not copy the invitation. Try again.",
  workspaceIdLabel: "Workspace ID",
  workspaceNameMissing: "Unnamed workspace",
  workspaceInformation: "Workspace information",
  executorServerSelector: "Executor Server",
  serverWorkspaceConnections: "Saved workspace connections",
  serverCurrentConnection: "Current connection",
  serverUseConnection: "Use connection",
  serverForgetConnection: "Remove saved connection",
  workspaceCurrent: "Current workspace",
  workspaceJoinAnother: "Join another workspace…",
  workspaceNavigation: "Workspace",
  workspaceSharedCanvases: "Shared canvases",
  workspaceMembersAccess: "Members",
  workspaceShareAction: "Share canvas",
  workspaceInviteAction: "Invite member",
  workspaceSearchCanvases: "Search canvases",
  workspaceSearchMembers: "Search members",
  workspaceAllProjects: "All projects",
  workspaceCanvasColumn: "Canvas",
  workspaceProjectColumn: "Project",
  workspacePermissionColumn: "My access",
  workspaceUpdatedColumn: "Updated",
  workspaceRoleColumn: "Role",
  workspaceCanvasCount: "{count} shared canvases",
  workspaceNoResults: "No matching results",
  workspaceNoSharedCanvases: "No shared canvases yet. Share a local canvas to get started.",
  workspaceUnavailable: "Workspace is disconnected. Reconnect to view shared canvases.",
  workspaceReadAccess: "Read only",
  workspaceWriteAccess: "Can edit",
  workspaceAccessSettings: "Canvas permissions",
  workspacePendingInvitations: "Pending invitations",
  workspaceMembershipHint:
    "Workspace members can view shared canvases. Editing and private canvas access require separate authorization.",
  managementActions: "More actions",
  managementDetails: "Details",
  managementConfigure: "Configure",
  managementRefresh: "Refresh",
  executorOwnerCanvasHint: "Allow this executor to run your local canvas tasks.",
  executorUnrestrictedHint: "Available to all workspaces you can access.",
  executorRestrictedHint: "Available only in workspaces enabled below.",
  executorTechnicalDetails: "Technical details",
  executorsNavigation: "Executors",
  executorsList: "Executor list",
  executorsDevices: "Execution devices",
  executorsAddDevice: "Connect device",
  executorsSearch: "Search executors",
  executorsAllLocations: "All locations",
  executorsLocal: "This computer",
  executorsRemote: "Remote devices",
  executorsLocationColumn: "Location",
  executorsStatusColumn: "Status",
  executorsAccessColumn: "Access scope",
  executorsReady: "Ready",
  executorsNotInstalled: "Not installed",
  executorsUnknown: "Not checked",
  executorsLocalScope: "Local tasks",
  executorsLocalConfiguration: "Local execution settings",
  executorsNoRemoteConnection: "Connect a Server in Settings to manage remote executors.",
  executorsDeviceUnknown: "Device status unavailable",
  executorsDeviceOnline: "Device online",
  serverLocalProcess: "Server on this computer",
  executorsServerSource: "Remote executors from",
  serverDeploymentMethod: "Deployment method",
  serverDeploymentTailscale: "Tailscale HTTPS (identified by address)",
  serverDeployHttps: "Deploy an HTTPS Server",
  serverDeployHttpsHint:
    "Configure an HTTPS endpoint and export the deployment package for another computer.",
  serverConnections: "Connections",
  serverMaintenance: "Deployment & maintenance",
  serverAddConnection: "Add connection",
  serverSavedConnections: "Saved connections",
  serverConnectionEmpty: "No saved Server connections",
  serverRemembered: "Saved",
  serverLocalStopped: "Stopped",
  serverForgetConfirm:
    "Forget this Server connection? Its saved connection credentials will be removed from this computer.",
  serverConnectionHint:
    "Server connections are saved on this computer. Workspace membership and executor access are managed in their own pages."
} as const;
