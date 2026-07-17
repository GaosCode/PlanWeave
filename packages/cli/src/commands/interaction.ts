import type { Command } from "commander";
import {
  listPendingRunnerInteractions,
  respondToRunnerInteractionAction,
  runnerInteractionActionIdentitySchema,
  RunnerInteractionApiError,
  type RunnerInteractionSnapshot
} from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliCanvasId, type CanvasCommandOptions } from "../cliWorkspace.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

type InteractionListOptions = CanvasCommandOptions & { json?: boolean };
type InteractionRespondOptions = CanvasCommandOptions & {
  record: string;
  request: string;
  lease: string;
  option?: string;
  cancel?: boolean;
  source: string;
  reason?: string;
  json?: boolean;
};

async function interactionCanvasRef(options: CanvasCommandOptions) {
  return {
    projectRoot: await resolveCliProjectRoot(),
    canvasId: resolveCliCanvasId(options)
  };
}

function formatInteractionList(interactions: RunnerInteractionSnapshot[]): string {
  if (interactions.length === 0) return "No actionable runner interactions.";
  return interactions
    .map(({ request }) => {
      const recordId = `${request.identity.claimRef}::${request.identity.executorRunId}`;
      return [
        `${recordId} ${request.identity.requestId}: ${request.summary}`,
        ...request.options.map(
          (option) => `  ${option.optionId}: ${option.label} (${option.decision})`
        )
      ].join("\n");
    })
    .join("\n");
}

function printInteractionError(error: RunnerInteractionApiError): void {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })}\n`
  );
  process.exitCode = 1;
}

function interactionDecision(options: InteractionRespondOptions) {
  if (options.cancel === true) {
    return { kind: "cancel" } as const;
  }
  if (options.option === undefined) {
    throw new Error("interaction respond requires --option when --cancel is omitted.");
  }
  return { kind: "select", optionId: options.option } as const;
}

export function registerInteractionCommand(program: Command): void {
  const interaction = program
    .command("interaction")
    .description("List or respond to actionable runner interactions");

  addCanvasOption(
    interaction
      .command("list")
      .description("List actionable pending runner interactions")
      .option("--json", "print JSON output")
  ).action(async (options: InteractionListOptions) => {
    try {
      const interactions = await listPendingRunnerInteractions(await interactionCanvasRef(options));
      if (options.json) {
        console.log(JSON.stringify(interactions, null, 2));
        return;
      }
      console.log(formatInteractionList(interactions));
    } catch (error) {
      if (options.json && error instanceof RunnerInteractionApiError) {
        printInteractionError(error);
        return;
      }
      throw error;
    }
  });

  addCanvasOption(
    interaction
      .command("respond")
      .description("Submit one runner interaction decision")
      .requiredOption("--record <recordId>", "runner record id")
      .requiredOption("--request <requestId>", "runner interaction request id")
      .requiredOption("--lease <ownerLeaseId>", "runner owner lease id")
      .option("--option <optionId>", "select an advertised permission option")
      .option("--cancel", "cancel the permission request")
      .requiredOption("--source <clientLabel>", "stable audit label for the decision client")
      .option("--reason <text>", "audit reason (required with --cancel)")
      .option("--json", "print JSON output")
  ).action(async (options: InteractionRespondOptions) => {
    if ((options.option === undefined) === (options.cancel !== true)) {
      throw new Error("interaction respond requires exactly one of --option or --cancel.");
    }
    const reason = options.reason ?? null;
    if (options.cancel === true && (reason === null || reason.trim().length === 0)) {
      throw new Error("interaction respond --cancel requires --reason <text>.");
    }
    try {
      const receipt = await respondToRunnerInteractionAction(
        await interactionCanvasRef(options),
        runnerInteractionActionIdentitySchema.parse({
          recordId: options.record,
          requestId: options.request,
          ownerLeaseId: options.lease
        }),
        interactionDecision(options),
        {
          decisionSource: options.source,
          reason
        }
      );
      if (options.json) {
        console.log(JSON.stringify(receipt, null, 2));
        return;
      }
      const decision =
        receipt.selectedOption === null
          ? "cancelled"
          : `${receipt.selectedOption.decision}: ${receipt.selectedOption.label}`;
      console.log(`Runner interaction response accepted at ${receipt.acceptedAt} (${decision}).`);
    } catch (error) {
      if (options.json && error instanceof RunnerInteractionApiError) {
        printInteractionError(error);
        return;
      }
      throw error;
    }
  });
}
