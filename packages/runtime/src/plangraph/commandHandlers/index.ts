import type { PlanGraphCommand } from "../commands.js";
import { blockCommandHandler } from "./blockCommands.js";
import { bulkCommandHandler } from "./bulkCommands.js";
import { dependencyCommandHandler } from "./dependencyCommands.js";
import { layoutCommandHandler } from "./layoutCommands.js";
import { reviewCommandHandler } from "./reviewCommands.js";
import { taskCommandHandler } from "./taskCommands.js";
import type { PlanGraphCommandHandler } from "./types.js";

export const planGraphCommandHandlers = [
  dependencyCommandHandler,
  taskCommandHandler,
  blockCommandHandler,
  bulkCommandHandler,
  reviewCommandHandler,
  layoutCommandHandler
] as const satisfies readonly PlanGraphCommandHandler[];

export function handlerForCommand(command: PlanGraphCommand): PlanGraphCommandHandler | undefined {
  return planGraphCommandHandlers.find((handler) => handler.handles(command));
}

export type { PlanGraphCommandFamily, PlanGraphCommandHandler } from "./types.js";
