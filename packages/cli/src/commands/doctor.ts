import type { Command } from "commander";
import { runDoctor } from "@planweave/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check PlanWeave state/results consistency for agent recovery")
    .action(async () => {
      const result = await runDoctor({ projectRoot: resolveCliProjectRoot() });
      console.log(JSON.stringify(result, null, 2));
    });
}
