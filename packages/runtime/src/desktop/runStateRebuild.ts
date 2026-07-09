import type { ProjectWorkspace } from "../types.js";
import type { DesktopAutoRunState } from "./types.js";
import { compareRunDirectoriesNewestFirst, highestRunId } from "./autoRunIdReservations.js";
import {
  listRunDirectories,
  readPersistedAutoRunStateWithDiagnostics,
  type LatestPersistedAutoRunStateResult,
  type PersistedAutoRunStateReadDiagnostic
} from "./runStatePersistence.js";
import {
  compareAutoRunStatesNewestFirst,
  isRunIdNewerThan,
  readLatestAutoRunStatePointer,
  type LatestAutoRunStateDiagnosticEntry,
  type LatestAutoRunStatePointer,
  writeLatestAutoRunStatePointer
} from "./runStatePointer.js";

type LatestPersistedAutoRunStateScanResult = LatestPersistedAutoRunStateResult & {
  diagnosticEntries: LatestAutoRunStateDiagnosticEntry[];
  runIds: string[];
};

type LatestPersistedAutoRunStatePointerReadResult =
  | { kind: "result"; result: LatestPersistedAutoRunStateResult }
  | { kind: "selected_read_failed" }
  | { kind: "selected_filtered_out" };

function diagnosticsForSelectedState(
  state: DesktopAutoRunState | null,
  diagnosticEntries: LatestAutoRunStateDiagnosticEntry[]
): PersistedAutoRunStateReadDiagnostic[] {
  if (!state) {
    return diagnosticEntries.map((entry) => entry.diagnostic);
  }
  return diagnosticEntries
    .filter((entry) => isRunIdNewerThan(entry.runId, state.runId))
    .map((entry) => entry.diagnostic);
}

function latestPointerFromResult(
  result: LatestPersistedAutoRunStateScanResult
): LatestAutoRunStatePointer {
  return {
    version: 1,
    selectedRunId: result.state?.runId ?? null,
    selectedUpdatedAt: result.state?.updatedAt ?? null,
    highestRunId: highestRunId(result.runIds),
    diagnostics: result.state
      ? result.diagnosticEntries.filter((entry) =>
          isRunIdNewerThan(entry.runId, result.state?.runId ?? null)
        )
      : result.diagnosticEntries
  };
}

async function scanPersistedAutoRunStates(
  workspace: ProjectWorkspace,
  runIds: string[],
  options: {
    hasActiveLoop?: (runId: string) => boolean;
    matches?: (state: DesktopAutoRunState) => boolean;
  }
): Promise<LatestPersistedAutoRunStateScanResult> {
  const diagnosticEntries: LatestAutoRunStateDiagnosticEntry[] = [];
  const states: DesktopAutoRunState[] = [];
  for (const runId of runIds.sort(compareRunDirectoriesNewestFirst)) {
    const result = await readPersistedAutoRunStateWithDiagnostics(workspace, runId, {
      hasActiveLoop: options.hasActiveLoop?.(runId) ?? false
    });
    diagnosticEntries.push(...result.diagnostics.map((diagnostic) => ({ runId, diagnostic })));
    if (!result.state) {
      continue;
    }
    if (options.matches && !options.matches(result.state)) {
      continue;
    }
    states.push(result.state);
  }
  const state = states.sort(compareAutoRunStatesNewestFirst).at(0) ?? null;
  return {
    state,
    diagnostics: diagnosticsForSelectedState(state, diagnosticEntries),
    diagnosticEntries,
    runIds
  };
}

async function rebuildLatestPersistedAutoRunStatePointer(
  workspace: ProjectWorkspace,
  options: {
    hasActiveLoop?: (runId: string) => boolean;
  }
): Promise<LatestPersistedAutoRunStateResult> {
  const runIds = await listRunDirectories(workspace);
  const result = await scanPersistedAutoRunStates(workspace, runIds, options);
  await writeLatestAutoRunStatePointer(workspace, latestPointerFromResult(result));
  return {
    state: result.state,
    diagnostics: result.diagnostics
  };
}

async function readLatestPersistedAutoRunStateFromPointer(
  workspace: ProjectWorkspace,
  pointer: LatestAutoRunStatePointer,
  options: {
    hasActiveLoop?: (runId: string) => boolean;
    matches?: (state: DesktopAutoRunState) => boolean;
  },
  persistPointer: boolean
): Promise<LatestPersistedAutoRunStatePointerReadResult> {
  const states: DesktopAutoRunState[] = [];
  const diagnosticEntries: LatestAutoRunStateDiagnosticEntry[] = [];
  let selectedReadFailed = false;
  let selectedFilteredOut = false;

  if (pointer.selectedRunId) {
    const selected = await readPersistedAutoRunStateWithDiagnostics(
      workspace,
      pointer.selectedRunId,
      {
        hasActiveLoop: options.hasActiveLoop?.(pointer.selectedRunId) ?? false
      }
    );
    diagnosticEntries.push(
      ...selected.diagnostics.map((diagnostic) => ({
        runId: pointer.selectedRunId as string,
        diagnostic
      }))
    );
    if (selected.state && (!options.matches || options.matches(selected.state))) {
      states.push(selected.state);
    } else if (selected.state) {
      selectedFilteredOut = true;
    } else {
      selectedReadFailed = true;
    }
  }

  for (const entry of pointer.diagnostics) {
    const result = await readPersistedAutoRunStateWithDiagnostics(workspace, entry.runId, {
      hasActiveLoop: options.hasActiveLoop?.(entry.runId) ?? false
    });
    diagnosticEntries.push(
      ...result.diagnostics.map((diagnostic) => ({ runId: entry.runId, diagnostic }))
    );
    if (result.state && (!options.matches || options.matches(result.state))) {
      states.push(result.state);
    }
  }

  if (selectedReadFailed) {
    return { kind: "selected_read_failed" };
  }

  if (selectedFilteredOut) {
    return { kind: "selected_filtered_out" };
  }

  const runIds = await listRunDirectories(workspace);
  const newRunIds = runIds.filter((runId) => isRunIdNewerThan(runId, pointer.highestRunId));
  const newRuns = await scanPersistedAutoRunStates(workspace, newRunIds, options);
  if (newRuns.state) {
    states.push(newRuns.state);
  }
  diagnosticEntries.push(...newRuns.diagnosticEntries);

  const state = states.sort(compareAutoRunStatesNewestFirst).at(0) ?? null;
  const result: LatestPersistedAutoRunStateScanResult = {
    state,
    diagnostics: diagnosticsForSelectedState(state, diagnosticEntries),
    diagnosticEntries,
    runIds: [...new Set([...runIds, ...newRunIds])]
  };
  if (persistPointer) {
    await writeLatestAutoRunStatePointer(workspace, latestPointerFromResult(result));
  }
  return {
    kind: "result",
    result: {
      state: result.state,
      diagnostics: result.diagnostics
    }
  };
}

export async function readLatestPersistedAutoRunState(
  workspace: ProjectWorkspace,
  options: {
    hasActiveLoop?: (runId: string) => boolean;
    matches?: (state: DesktopAutoRunState) => boolean;
  } = {}
): Promise<LatestPersistedAutoRunStateResult> {
  const hasMatchFilter = typeof options.matches === "function";
  let pointer = await readLatestAutoRunStatePointer(workspace);
  if (!pointer && hasMatchFilter) {
    await rebuildLatestPersistedAutoRunStatePointer(workspace, {
      hasActiveLoop: options.hasActiveLoop
    });
    pointer = await readLatestAutoRunStatePointer(workspace);
  }
  if (pointer) {
    const result = await readLatestPersistedAutoRunStateFromPointer(
      workspace,
      pointer,
      options,
      !hasMatchFilter
    );
    if (result.kind === "result") {
      return result.result;
    }
    if (result.kind === "selected_read_failed") {
      await rebuildLatestPersistedAutoRunStatePointer(workspace, {
        hasActiveLoop: options.hasActiveLoop
      });
      const repairedPointer = await readLatestAutoRunStatePointer(workspace);
      if (repairedPointer) {
        const repairedResult = await readLatestPersistedAutoRunStateFromPointer(
          workspace,
          repairedPointer,
          options,
          !hasMatchFilter
        );
        if (repairedResult.kind === "result") {
          return repairedResult.result;
        }
      }
    }
  }
  if (hasMatchFilter) {
    const result = await scanPersistedAutoRunStates(
      workspace,
      await listRunDirectories(workspace),
      options
    );
    return {
      state: result.state,
      diagnostics: result.diagnostics
    };
  }
  return rebuildLatestPersistedAutoRunStatePointer(workspace, {
    hasActiveLoop: options.hasActiveLoop
  });
}
