import type { Command } from "commander";
import {
  listPendingRunnerInteractions,
  respondToRunnerInteractionAction,
  runnerInteractionActionIdentitySchema,
  RunnerInteractionApiError,
  type RunnerInteractionSnapshot
} from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliCanvasId,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";
import { resolveCliProjectRoot } from "../projectRoot.js";
import {
  interactionResponse,
  loadRemoteSessionInteractions,
  listRemoteSessionInteractions
} from "../workspaceExecution/session.js";
import { WorkspaceExecutionCliError } from "../workspaceExecution/errors.js";

type InteractionListOptions = CanvasCommandOptions & {
  json?: boolean;
  session?: string;
  connectionProfile?: string;
};
type InteractionRespondOptions = CanvasCommandOptions & {
  record?: string;
  request?: string;
  lease?: string;
  option?: string;
  cancel?: boolean;
  source?: string;
  reason?: string;
  json?: boolean;
  session?: string;
  action?: string;
  dispatch?: string;
  attempt?: string;
  acpSession?: string;
  connectionProfile?: string;
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
      .option("--session <sessionId>", "list Remote Agent interactions for a run session")
      .option("--connection-profile <profileId>", "select a preconfigured Workspace connection")
      .option("--json", "print JSON output")
  ).action(async (options: InteractionListOptions) => {
    if (options.session) {
      const items = await listRemoteSessionInteractions({
        projectRoot: await resolveCliPackageWorkspace(options),
        sessionId: options.session,
        connectionProfile: options.connectionProfile
      });
      const pending = items.filter((item) => item.status === "pending");
      if (options.json) console.log(JSON.stringify(pending, null, 2));
      else if (pending.length === 0) console.log("No actionable remote interactions.");
      else {
        for (const item of pending) {
          console.log(`${item.request.actionId}\t${item.request.type}\t${item.request.expiresAt}`);
        }
      }
      return;
    }
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
      .option("--record <recordId>", "runner record id")
      .option("--request <requestId>", "runner interaction request id")
      .option("--lease <ownerLeaseId>", "runner owner lease id")
      .option("--option <optionId>", "select an advertised permission option")
      .option("--cancel", "cancel the permission request")
      .option("--source <clientLabel>", "stable audit label for the local runner decision client")
      .option("--reason <text>", "audit reason (required with --cancel)")
      .option("--session <sessionId>", "respond to a Remote Agent interaction by run session")
      .option("--action <actionId>", "remote interaction action id")
      .option("--dispatch <dispatchId>", "remote interaction dispatch id")
      .option("--attempt <executionAttemptId>", "remote interaction execution attempt id")
      .option("--acp-session <acpSessionId>", "remote interaction ACP session id")
      .option("--connection-profile <profileId>", "select a preconfigured Workspace connection")
      .option("--json", "print JSON output")
  ).action(async (options: InteractionRespondOptions) => {
    if (options.session) {
      if (
        !options.action ||
        !options.dispatch ||
        !options.lease ||
        !options.attempt ||
        !options.acpSession ||
        (options.option === undefined) === (options.cancel !== true)
      ) {
        throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
      }
      const projectRoot = await resolveCliPackageWorkspace(options);
      const { context, items: interactions } = await loadRemoteSessionInteractions({
        projectRoot,
        sessionId: options.session,
        connectionProfile: options.connectionProfile
      });
      const selected = interactions.find(
        (item) =>
          item.request.actionId === options.action &&
          item.request.dispatchId === options.dispatch &&
          item.request.leaseId === options.lease &&
          item.request.executionAttemptId === options.attempt &&
          item.request.acpSessionId === options.acpSession
      );
      if (!selected) {
        throw new WorkspaceExecutionCliError("remote_interaction_not_found", 7);
      }
      if (selected.status === "expired") {
        throw new WorkspaceExecutionCliError("remote_interaction_expired", 7);
      }
      if (selected.status === "settled") {
        throw new WorkspaceExecutionCliError("remote_interaction_already_settled", 7);
      }
      const event = await context.coordinator.respond({
        request: context.request,
        sessionId: options.session,
        response: interactionResponse({
          request: selected.request,
          option: options.option,
          cancel: options.cancel
        })
      });
      if (options.json) console.log(JSON.stringify(event, null, 2));
      else console.log(`Remote interaction ${options.action} accepted.`);
      return;
    }
    if (!options.record || !options.request || !options.lease || !options.source) {
      throw new Error(
        "local interaction respond requires --record, --request, --lease, and --source."
      );
    }
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
