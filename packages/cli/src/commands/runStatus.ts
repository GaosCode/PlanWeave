import type { Command } from "commander";
import {
  getAutoRunStatus,
  getLatestAutoRunSummary,
  isFailedAutoRunTerminalPhase,
  readRunnerRecordReadModelForArtifact,
  tailAutoRunEvents,
  type AutoRunEventTailItem,
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
  const seen = new Set<number>();
  while (!signal.aborted) {
    const model = await readRunnerRecordReadModelForArtifact(metadataPath);
    if (!model) return;
    for (const event of model.events) {
      if (seen.has(event.sequence)) continue;
      seen.add(event.sequence);
      console.log(
        asJson
          ? JSON.stringify({ kind: "runner_event", event })
          : `${event.timestamp} runner_event sequence=${event.sequence} kind=${event.body.kind}`
      );
    }
    for (const diagnostic of model.diagnostics) {
      console.log(
        asJson
          ? JSON.stringify({ kind: "runner_diagnostic", diagnostic })
          : `runner_diagnostic ${diagnostic.code}: ${diagnostic.message}`
      );
    }
    if (model.interaction.persisted) {
      const interaction = {
        persisted: model.interaction.persisted,
        active: model.interaction.active,
        stale: model.interaction.stale
      };
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
    if (!latest) {
      const latestRunner = status.latestRuns.find(
        (run) => run.runnerKind === "acp" && run.metadataPath !== null
      );
      if (latestRunner?.metadataPath) {
        const abort = new AbortController();
        const onSigInt = (): void => abort.abort();
        process.on("SIGINT", onSigInt);
        try {
          await followLatestRunnerRecord(
            latestRunner.metadataPath,
            options.json === true,
            abort.signal
          );
        } finally {
          process.off("SIGINT", onSigInt);
        }
        return;
      }
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
      for await (const item of tailAutoRunEvents(workspace, canvasId, latest.runId, {
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
