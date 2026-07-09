import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { dispatchPlanweaveTool } from "./toolDispatcher.js";
import { runtimeGateway } from "./toolRuntime.js";
import {
  compatPlanweaveToolNames,
  debugPlanweaveToolNames,
  defaultPlanweaveToolNames,
  planweaveToolNames,
  type PlanweaveToolName,
  type RuntimeGateway
} from "./toolTypes.js";

export {
  compatPlanweaveToolNames,
  debugPlanweaveToolNames,
  defaultPlanweaveToolNames,
  planweaveToolNames,
  type PlanweaveToolName,
  type RuntimeGateway
};

export async function handlePlanweaveTool(
  name: PlanweaveToolName,
  args: unknown,
  gateway: RuntimeGateway = runtimeGateway
): Promise<CallToolResult> {
  return dispatchPlanweaveTool(name, args, gateway);
}

export function isPlanweaveToolName(value: string): value is PlanweaveToolName {
  return planweaveToolNames.includes(value as PlanweaveToolName);
}
