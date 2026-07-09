import type { PlanPackageGraphMutation } from "../../graph/mutation.js";
import type {
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  UpdateLayoutCommand
} from "../commands.js";
import type { LoadedPlanGraphPackage } from "../packageRepository.js";
import { diagnostic, type PlanGraphCommandHandler } from "./types.js";

export const layoutCommandHandler: PlanGraphCommandHandler<UpdateLayoutCommand> = {
  family: "layout",
  commandTypes: ["updateLayout"],
  handles(command: PlanGraphCommand): command is UpdateLayoutCommand {
    return command.type === "updateLayout";
  },
  mutation(
    _loaded: LoadedPlanGraphPackage,
    _command: UpdateLayoutCommand
  ): PlanPackageGraphMutation | PlanGraphCommandDiagnostic {
    return diagnostic(
      "layout_command_not_handled",
      "PlanGraph layout commands are defined here but still written by the existing layout API."
    );
  },
  inverse(): PlanGraphCommandDiagnostic {
    return diagnostic(
      "layout_command_not_handled",
      "PlanGraph layout commands are not undoable here."
    );
  },
  touchedRefs(): { tasks: string[]; blocks: string[] } {
    return { tasks: [], blocks: [] };
  }
};
