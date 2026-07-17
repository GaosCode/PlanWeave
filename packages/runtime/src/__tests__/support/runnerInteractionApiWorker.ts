import {
  listPendingRunnerInteractions,
  respondToRunnerInteraction
} from "../../desktop/runnerInteractionApi.js";

const projectRoot = process.argv[2];
if (!projectRoot) {
  throw new Error("Runner interaction API worker requires a project root.");
}

let pending = [] as Awaited<ReturnType<typeof listPendingRunnerInteractions>>;
for (let attempt = 0; attempt < 300 && pending.length === 0; attempt += 1) {
  pending = await listPendingRunnerInteractions({ projectRoot, canvasId: "default" });
  if (pending.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const interaction = pending[0];
if (!interaction) {
  throw new Error("Runner interaction API worker did not observe a pending request.");
}
const option = interaction.request.options.find((item) => item.decision === "approve");
if (!option) {
  throw new Error("Runner interaction API worker did not receive an approve option.");
}
const receipt = await respondToRunnerInteraction(
  { projectRoot, canvasId: "default" },
  interaction.request.identity,
  { kind: "select", optionId: option.optionId },
  { decisionSource: "runtime-worker", reason: null }
);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
