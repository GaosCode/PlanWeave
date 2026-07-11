import type { Command } from "commander";
import {
  getAutoRunStatus,
  getLatestAutoRunSummary,
  isFailedAutoRunTerminalPhase,
  readRunnerRecordReadModelForArtifact,
  tailAutoRunEvents,
  type AutoRunEventTailItem,
  type RunnerRecordReadModel,
  type PackageWorkspaceRef
} from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliCanvasId,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";
import { explicitCliProjectRoot } from "../projectRoot.js";
import { formatAutoRunEventTailItem, formatRunStatusHuman } from "./formatters/runFormatters.js";

function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function formatRunCommand(options: CanvasCommandOptions): string {
  const canvasId = resolveCliCanvasId(options);
  const projectRoot = explicitCliProjectRoot();
  return [
    "planweave",
    ...(projectRoot ? ["--project-root", projectRoot] : []),
    "run",
    ...(canvasId ? ["--canvas", canvasId] : [])
  ]
    .map(shellQuoteArg)
    .join(" ");
}

function packageRootPath(ref: PackageWorkspaceRef): string {
  return typeof ref === "string" ? ref : ref.rootPath;
}

/** When the workspace is already canvas-resolved, do not pass canvasId again. */
function desktopCanvasId(ref: PackageWorkspaceRef, options: CanvasCommandOptions): string | null {
  return typeof ref === "string" ? resolveCliCanvasId(options) : null;
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

async function followLatestRunnerRecord(
  metadataPath: string,
  asJson: boolean,
  signal: AbortSignal
): Promise<void> {
  const deduplicator = new RunnerFollowDeduplicator();
  while (!signal.aborted) {
    const model = await readRunnerRecordReadModelForArtifact(metadataPath);
    if (!model) return;
    const fresh = deduplicator.take(model);
    for (const event of fresh.events) {
      console.log(
        asJson
          ? JSON.stringify({ kind: "runner_event", event })
          : `${event.timestamp} runner_event sequence=${event.sequence} kind=${event.body.kind}`
      );
    }
    for (const diagnostic of fresh.diagnostics) {
      console.log(
        asJson
          ? JSON.stringify({ kind: "runner_diagnostic", diagnostic })
          : `runner_diagnostic ${diagnostic.code}: ${diagnostic.message}`
      );
    }
    if (fresh.interaction) {
      const interaction = fresh.interaction;
      console.log(
        asJson
          ? JSON.stringify({ kind: "runner_interaction", interaction })
          : `runner_interaction persisted=${interaction.persisted} active=${interaction.active} stale=${interaction.stale}`
      );
    }
    if (model.terminal) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export class RunnerFollowDeduplicator {
  readonly #events = new Set<number>();
  readonly #diagnostics = new Set<string>();
  #lastInteraction: string | null = null;

  take(model: Pick<RunnerRecordReadModel, "events" | "diagnostics" | "interaction">) {
    const events = model.events.filter((event) => {
      if (this.#events.has(event.sequence)) return false;
      this.#events.add(event.sequence);
      return true;
    });
    const diagnostics = model.diagnostics.filter((diagnostic) => {
      const identity = JSON.stringify([diagnostic.code, diagnostic.line, diagnostic.message]);
      if (this.#diagnostics.has(identity)) return false;
      this.#diagnostics.add(identity);
      return true;
    });
    const interaction = model.interaction.persisted ? { ...model.interaction } : null;
    if (!interaction) {
      this.#lastInteraction = null;
      return { events, diagnostics, interaction };
    }
    const identity = JSON.stringify(interaction);
    if (this.#lastInteraction === identity) return { events, diagnostics, interaction: null };
    this.#lastInteraction = identity;
    return { events, diagnostics, interaction };
  }
}

type FollowSelection =
  | { kind: "runner_record"; metadataPath: string; timestamp: number; identity: string }
  | { kind: "desktop_run"; runId: string; timestamp: number; identity: string }
  | null;

function timestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function selectRunStatusFollowTarget(
  status: {
    explanation: { latestRecordId: string | null; latestRecordPath: string | null };
    latestRuns: Array<{
      metadataPath: string | null;
      runnerKind: string | null;
      startedAt: string | null;
      finishedAt: string | null;
    }>;
  },
  desktop: {
    runId: string;
    updatedAt: string;
    latestRecordId: string | null;
  } | null
): FollowSelection {
  const exactPath = status.explanation.latestRecordPath;
  const exactRun = exactPath
    ? status.latestRuns.find((run) => run.metadataPath === exactPath)
    : undefined;
  const runnerCandidate =
    exactPath && exactRun?.runnerKind === "acp"
      ? {
          kind: "runner_record" as const,
          metadataPath: exactPath,
          timestamp: timestamp(exactRun.finishedAt ?? exactRun.startedAt),
          identity: status.explanation.latestRecordId ?? exactPath
        }
      : null;
  const desktopCandidate = desktop
    ? {
        kind: "desktop_run" as const,
        runId: desktop.runId,
        timestamp: timestamp(desktop.updatedAt),
        identity: desktop.latestRecordId ?? desktop.runId
      }
    : null;
  if (!runnerCandidate) return desktopCandidate;
  if (!desktopCandidate) return runnerCandidate;
  if (runnerCandidate.identity === desktopCandidate.identity) return runnerCandidate;
  return runnerCandidate.timestamp >= desktopCandidate.timestamp
    ? runnerCandidate
    : desktopCandidate;
}

export function registerRunStatusCommand(program: Command): void {
  addCanvasOption(
    program
      .command("run-status")
      .description("Show current PlanWeave runner state")
      .option("--json", "print JSON output")
      .option(
        "--follow",
        "after the status snapshot, stream Auto Run events until terminal state or Ctrl-C"
      )
  ).action(async (options: { json?: boolean; follow?: boolean } & CanvasCommandOptions) => {
    const workspace = await resolveCliPackageWorkspace(options);
    const status = await getAutoRunStatus({ projectRoot: workspace });
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(formatRunStatusHuman(status, { defaultStartCommand: formatRunCommand(options) }));
    }

    if (options.follow !== true) {
      return;
    }

    const rootPath = packageRootPath(workspace);
    const canvasId = desktopCanvasId(workspace, options);
    const latest = await getLatestAutoRunSummary(rootPath, canvasId);
    const followTarget = selectRunStatusFollowTarget(status, latest);
    if (followTarget?.kind === "runner_record") {
      const abort = new AbortController();
      const onSigInt = (): void => abort.abort();
      process.on("SIGINT", onSigInt);
      try {
        await followLatestRunnerRecord(
          followTarget.metadataPath,
          options.json === true,
          abort.signal
        );
      } finally {
        process.off("SIGINT", onSigInt);
      }
      return;
    }
    if (!followTarget) {
      if (!options.json) {
        console.log("events: none (no Auto Run session found)");
      }
      return;
    }

    const abort = new AbortController();
    const onSigInt = (): void => {
      abort.abort();
    };
    process.on("SIGINT", onSigInt);
    try {
      let terminalPhase: string | null = null;
      for await (const item of tailAutoRunEvents(workspace, canvasId, followTarget.runId, {
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
}
