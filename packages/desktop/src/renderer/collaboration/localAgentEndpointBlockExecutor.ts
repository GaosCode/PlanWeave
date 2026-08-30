import type { DesktopAutoRunScope, DesktopAutoRunState } from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { AgentEndpointBlockSelection } from "./agentEndpointRunPlan";
import {
  type LocalAutoRunObserver,
  runClaimBusLocalAutoRunUnit,
  waitForClaimBusLocalAutoRunUnit
} from "./agentEndpointScopeRun";

export function createLocalAgentEndpointBlockExecutor(input: {
  startLocal: (
    scope: DesktopAutoRunScope,
    options?: { stepLimit?: number }
  ) => Promise<DesktopAutoRunState | null | undefined>;
  stopLocal: (runId: string) => Promise<unknown>;
  localAutoRunApi?: LocalAutoRunObserver | null;
  waitForLocalUnit?: typeof waitForClaimBusLocalAutoRunUnit;
}): (selection: AgentEndpointBlockSelection, signal?: AbortSignal) => Promise<void> {
  return async (selection, signal) => {
    if (selection.endpoint.source !== "local") {
      throw new Error(`local_agent_endpoint_required:${selection.block.ref}`);
    }
    const localApi = input.localAutoRunApi === undefined ? bridge : input.localAutoRunApi;
    if (!localApi) throw new Error("desktop_bridge_unavailable");
    await runClaimBusLocalAutoRunUnit({
      scope: { kind: "block", blockRef: selection.block.ref },
      startLocal: input.startLocal,
      stopLocal: input.stopLocal,
      api: localApi,
      unitLabel: selection.block.ref,
      signal,
      waitForUnit: input.waitForLocalUnit
    });
  };
}
