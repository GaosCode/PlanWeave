import type { remoteAgentManagementEnCatalog } from "./i18nRemoteAgentManagementEn";

export const remoteAgentManagementZhCnCatalog = {
  remoteAgentManagementTitle: "远程 Agent",
  remoteAgentManagementDescription:
    "先选择设备，再管理该设备暴露的 Agent 及其 Workspace 访问权限。",
  remoteAgentManagementDevices: "设备",
  remoteAgentManagementExposedAgents: "已暴露 Agent",
  remoteAgentManagementNoAgentsForDevice: "该设备没有暴露当前人员拥有的 Agent。",
  remoteAgentManagementUnknownDevice: "未知设备",
  remoteAgentManagementDeviceOnline: "在线",
  remoteAgentManagementDeviceOffline: "离线",
  remoteAgentManagementPermissions: "访问与授权",
  remoteAgentManagementRefresh: "刷新",
  remoteAgentManagementEmpty: "当前人员还没有登记的远程 Agent。",
  remoteAgentManagementNoPrincipal: "请先连接 Workspace 配置文件，以便 Desktop 识别 Agent 所有者。",
  remoteAgentManagementAccessMode: "访问模式",
  remoteAgentManagementUnrestricted: "不限制 Workspace",
  remoteAgentManagementWorkspaceRestricted: "仅限已授权 Workspace",
  remoteAgentManagementGrants: "Workspace 授权",
  remoteAgentManagementNoGrants: "暂无有效授权",
  remoteAgentManagementAddGrant: "添加授权",
  remoteAgentManagementWorkspaceId: "Workspace ID",
  remoteAgentManagementRevokeGrant: "撤销授权",
  remoteAgentManagementRevokeAgent: "撤销 Agent",
  remoteAgentManagementRevokeAgentConfirm:
    "撤销此远程 Agent？已有授权会保留为历史记录，新的 Dispatch 会被拒绝。",
  remoteAgentManagementRepairRequired: "需要修复所有者",
  remoteAgentManagementRepairOwner: "所有者 Principal ID",
  remoteAgentManagementRepairSubmit: "指定所有者",
  remoteAgentManagementOwnerPicker: "选择人员",
  remoteAgentManagementPrincipalId: "当前人员",
  remoteAgentManagementRevoked: "已撤销"
} satisfies Record<keyof typeof remoteAgentManagementEnCatalog, string>;
