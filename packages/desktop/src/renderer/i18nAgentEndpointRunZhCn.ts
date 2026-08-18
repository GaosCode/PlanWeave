import type { agentEndpointRunEnCatalog } from "./i18nAgentEndpointRunEn";

export const agentEndpointRunZhCnCatalog = {
  claimBusBlockedError:
    "认领总线在下一单元前停止（{reason}）。请先解除阻塞条件，再重新运行。[{code}]",
  claimBusIdleError:
    "已无可用认领单元，但本范围尚未完成（{reason}）。请等待状态同步或处理剩余块后重跑。[{code}]",
  claimBusCancelledError: "认领总线运行已取消。准备好后请重新开始。[{code}]",
  claimBusRouteMissingError:
    "块 {block} 没有本地/远程路由。请为该块重新选择 Agent Endpoint，再运行。[{code}]",
  localAgentUnitFailedError:
    "块 {block} 的本地 agent 单元以 {phase} 结束。请检查该块的 Auto Run 失败原因，修复后重跑。[{code}]",
  localAgentRunNotStartedError:
    "块 {block} 的本地 Auto Run 未能启动。请检查 Desktop Auto Run 控件后重试。[{code}]",
  agentEndpointPreferenceMismatchError:
    "块 {block} 的 Endpoint 绑定与包内执行器不一致（{detail}）。请在 Desktop 中重新选择 Agent Endpoint。[{code}]",
  agentEndpointSelectionMissingError:
    "块 {block} 没有 Endpoint 选择。请先选择 Agent Endpoint，再运行。[{code}]",
  agentEndpointUnavailableError:
    "Endpoint「{endpoint}」对块 {block} 不可用（{reason}）。请恢复可用性或改选 Endpoint 后重跑。[{code}]",
  agentEndpointUnknownError:
    "块 {block} 保存的远程 Endpoint 未知（{endpoint}）。请在 Desktop 中重新选择 Agent Endpoint。[{code}]",
  remoteAgentBlockFailedError:
    "块 {block} 的远程运行以 {state} 结束。请检查 Host/operation 详情后重试。[{code}]",
  remoteAgentFailureError: "{message} 请处理该块的 Host/远程失败后重试。[{code}]",
  collaborationRuntimeStatusUnavailableError:
    "协作运行时状态不可用。请打开设置 → 连接与设备 → Server，发布或同步权威内容后再重跑。[{code}]",
  collaborationRuntimeTaskStatusUnavailableError:
    "任务 {task} 的协作状态缺失。请刷新画布或重新连接后再重跑。[{code}]",
  collaborationRuntimeBlockStatusUnavailableError:
    "块 {block} 的协作状态缺失。请刷新画布或重新连接后再重跑。[{code}]",
  agentEndpointFleetCredentialMissing:
    "列出远程 Agent Host 需要 server-admin 凭证。请打开设置 → 连接与设备并导入 operator token。[{code}]",
  agentEndpointFleetProfileNotActive:
    "请在设置 → 连接与设备中选择 server-admin 配置文件以列出远程 Agent Host。[{code}]",
  agentEndpointFleetBridgeUnavailable:
    "Desktop 无法访问 server-admin 控制面。请重启 Desktop 后重试。[{code}]",
  agentEndpointFleetLocalServerNotReady: "本地协作 Server 仍在启动中，请稍候再试。[{code}]",
  agentEndpointFleetLoadFailed:
    "无法加载远程 Agent Host endpoint。请检查设置 → 连接与设备后重试。[{code}]"
} satisfies Record<keyof typeof agentEndpointRunEnCatalog, string>;
