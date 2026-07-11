import type { Command } from "commander";
import {
  applyPrunePlan,
  computePrunePlan,
  getRunSession,
  isFailedAutoRunTerminalPhase,
  listAutoRunEvents,
  listRunSessions,
  readRunnerRecordReadModelForArtifact,
  tailAutoRunEvents,
  type AutoRunEventTailItem,
  type PackageWorkspaceRef,
  type PrunePlan
} from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliCanvasId,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";
import {
  formatAutoRunEventLogHuman,
  formatAutoRunEventTailItem,
  formatRunSessionDetail,
  formatRunSessions
} from "./formatters/runFormatters.js";

type JsonCommandOptions = {
  json?: boolean;
} & CanvasCommandOptions;

type EventsCommandOptions = {
  follow?: boolean;
  json?: boolean;
} & CanvasCommandOptions;

/** When the workspace is already canvas-resolved, do not pass canvasId again. */
function desktopCanvasId(ref: PackageWorkspaceRef, options: CanvasCommandOptions): string | null {
  return typeof ref === "string" ? resolveCliCanvasId(options) : null;
}

type PruneCommandOptions = {
  olderThan?: string;
  keepLast?: string;
  dryRun?: boolean;
  force?: boolean;
  reason?: string;
  json?: boolean;
} & CanvasCommandOptions;

function parseKeepLast(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`--keep-last must be a non-negative integer, got '${value}'.`);
  }
  if (parsed < 0) {
    throw new Error(`--keep-last must be a non-negative integer, got '${value}'.`);
  }
  return parsed;
}

function formatPrunePlanHuman(
  plan: PrunePlan,
  mode: "dry-run" | "applied",
  deletedCount?: number
): string {
  const lines = [
    `prune mode: ${mode}`,
    `candidates: ${plan.items.length}`,
    `excluded: ${plan.excludedCount}`,
    `totals: sessions=${plan.totals.sessions} runs=${plan.totals.runs} reviews=${plan.totals.reviewAttempts} feedbackSubmissions=${plan.totals.feedbackSubmissions}`
  ];
  if (deletedCount !== undefined) {
    lines.push(`deleted: ${deletedCount}`);
  }
  if (plan.items.length === 0) {
    lines.push("items: none");
  } else {
    lines.push("items:");
    for (const item of plan.items) {
      lines.push(`- ${item.kind} ${item.id}: ${item.path} (${item.reason})`);
    }
  }
  return lines.join("\n");
}

export function registerRunSessionsCommands(program: Command): void {
  const runSessions = addCanvasOption(
    program
      .command("run-sessions")
      .description("List PlanWeave run/reset sessions or prune historical results")
  ).option("--json", "print JSON output");

  runSessions.action(async (options: JsonCommandOptions) => {
    const result = await listRunSessions(await resolveCliPackageWorkspace(options));
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatRunSessions(result));
  });

  addCanvasOption(
    runSessions
      .command("prune")
      .description("Dry-run or force-prune historical run sessions and superseded result artifacts")
      .option(
        "--older-than <duration>",
        "only consider artifacts older than duration (e.g. 30d, 12h, 45m)"
      )
      .option("--keep-last <n>", "keep the newest N terminal artifacts per container")
      .option(
        "--dry-run",
        "preview the prune plan without deleting (default when --force is omitted)"
      )
      .option("--force", "actually delete the planned set (requires --reason)")
      .option("--reason <text>", "why this prune is being performed (required with --force)")
      .option("--json", "print JSON output")
  ).action(async (options: PruneCommandOptions) => {
    if (options.force === true) {
      const reason = options.reason?.trim();
      if (!reason) {
        throw new Error("run-sessions prune --force requires --reason <text>.");
      }
    } else if (options.reason !== undefined && options.dryRun !== true) {
      // reason without force is allowed for dry-run annotation but still dry-runs
    }

    if (options.olderThan === undefined && options.keepLast === undefined) {
      throw new Error("run-sessions prune requires at least one of --older-than or --keep-last.");
    }

    const projectRoot = await resolveCliPackageWorkspace(options);
    const plan = await computePrunePlan(projectRoot, {
      olderThan: options.olderThan,
      keepLast: parseKeepLast(options.keepLast)
    });

    const force = options.force === true;
    if (!force) {
      const payload = { mode: "dry-run" as const, plan };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(formatPrunePlanHuman(plan, "dry-run"));
      return;
    }

    const applied = await applyPrunePlan(projectRoot, plan, { reason: options.reason!.trim() });
    const payload = { mode: "applied" as const, plan, applied };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(formatPrunePlanHuman(plan, "applied", applied.deleted.length));
    if (applied.skipped.length > 0) {
      console.log("skipped:");
      for (const item of applied.skipped) {
        console.log(`- ${item.kind} ${item.id}: ${item.skipReason}`);
      }
    }
  });

  addCanvasOption(
    runSessions
      .command("events")
      .argument("<run-id>", "Desktop Auto Run id (e.g. DESKTOP-RUN-0001)")
      .description("List or follow Auto Run events.ndjson for a desktop run id")
      .option("--follow", "stream new events until terminal state or Ctrl-C")
      .option("--json", "print JSON output")
  ).action(async (runId: string, _options: EventsCommandOptions, command: Command) => {
    // Parent `run-sessions` also defines --json/--canvas; merge so flags work after the subcommand.
    const options = command.optsWithGlobals() as EventsCommandOptions;
    const workspace = await resolveCliPackageWorkspace(options);
    const canvasId = desktopCanvasId(workspace, options);

    if (options.follow !== true) {
      const log = await listAutoRunEvents(workspace, canvasId, runId);
      if (options.json) {
        console.log(JSON.stringify(log, null, 2));
        return;
      }
      console.log(formatAutoRunEventLogHuman(log));
      return;
    }

    const abort = new AbortController();
    const onSigInt = (): void => {
      abort.abort();
    };
    process.on("SIGINT", onSigInt);
    try {
      let terminalPhase: string | null = null;
      for await (const item of tailAutoRunEvents(workspace, canvasId, runId, {
        signal: abort.signal
      })) {
        printTailItem(item, options.json === true);
        if (item.kind === "terminal") {
          terminalPhase = item.phase;
        }
      }
      if (isFailedAutoRunTerminalPhase(terminalPhase)) {
        process.exitCode = 1;
      }
    } finally {
      process.off("SIGINT", onSigInt);
    }
  });

  addCanvasOption(
    program
      .command("run-session")
      .argument("<session-id>")
      .description("Show one PlanWeave run/reset session")
      .option("--json", "print JSON output")
  ).action(async (sessionId: string, options: JsonCommandOptions) => {
    const result = await getRunSession(await resolveCliPackageWorkspace(options), sessionId);
    const runnerReadModel = await readRunnerRecordReadModelForArtifact(
      result.session.latestRecordPath
    );
    const output = { ...result, runnerReadModel };
    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(formatRunSessionDetail(output));
  });
}

function printTailItem(item: AutoRunEventTailItem, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(item));
    return;
  }
  if (item.kind === "terminal") {
    return;
  }
  console.log(formatAutoRunEventTailItem(item));
}
