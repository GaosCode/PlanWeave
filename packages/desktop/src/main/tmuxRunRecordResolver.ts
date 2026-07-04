import {
  getRunRecord,
  resolveTaskCanvasWorkspace,
  type DesktopCanvasReference,
  type DesktopOpenTerminalInput,
  type DesktopRunTerminalAvailability,
  type DesktopRunTerminalAvailabilityInput,
  type DesktopTerminalAttachMode
} from "@planweave-ai/runtime";
import { checkTmuxSessionAvailability } from "./terminalLauncher.js";

export type TmuxAttachIntent = {
  sessionName: string;
  cwd: string | null;
  mode: DesktopTerminalAttachMode;
};

export type TerminalOpenIntent = {
  cwd: string;
};

export function resolveDesktopTerminalAttachMode(mode: unknown): DesktopTerminalAttachMode {
  if (mode === undefined) {
    return "interactive";
  }
  if (mode === "readOnly" || mode === "interactive") {
    return mode;
  }
  throw new Error("Terminal attach mode is invalid.");
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function resolveTmuxAttachIntent(input: {
  ref: DesktopCanvasReference;
  recordId: string;
  mode?: unknown;
}): Promise<TmuxAttachIntent> {
  const workspaceRef = await resolveTaskCanvasWorkspace(input.ref.projectRoot, input.ref.canvasId);
  const record = await getRunRecord(workspaceRef, input.recordId);
  const sessionName = record.tmuxSessionId ?? metadataString(record.metadata, "tmuxSessionName");
  if (!sessionName) {
    throw new Error("Run record has no tmux session.");
  }
  return {
    sessionName,
    cwd: record.executionCwd ?? record.projectRoot,
    mode: resolveDesktopTerminalAttachMode(input.mode)
  };
}

export async function resolveTerminalOpenIntent(input: DesktopOpenTerminalInput): Promise<TerminalOpenIntent> {
  if (input.recordId) {
    const workspaceRef = await resolveTaskCanvasWorkspace(input.ref.projectRoot, input.ref.canvasId);
    const record = await getRunRecord(workspaceRef, input.recordId);
    return {
      cwd: record.executionCwd ?? record.projectRoot ?? input.ref.projectRoot
    };
  }
  return {
    cwd: input.ref.projectRoot
  };
}

export async function getRunTerminalAvailability(input: DesktopRunTerminalAvailabilityInput): Promise<DesktopRunTerminalAvailability[]> {
  const workspaceRef = await resolveTaskCanvasWorkspace(input.ref.projectRoot, input.ref.canvasId);
  return Promise.all(
    input.recordIds.map(async (recordId): Promise<DesktopRunTerminalAvailability> => {
      try {
        const record = await getRunRecord(workspaceRef, recordId);
        const sessionName = record.tmuxSessionId ?? metadataString(record.metadata, "tmuxSessionName");
        if (!sessionName) {
          return {
            recordId,
            tmuxSessionId: null,
            available: false,
            unavailableReason: "no_tmux_session"
          };
        }
        const unavailableReason = await checkTmuxSessionAvailability(sessionName);
        return {
          recordId,
          tmuxSessionId: sessionName,
          available: unavailableReason === null,
          unavailableReason
        };
      } catch {
        return {
          recordId,
          tmuxSessionId: null,
          available: false,
          unavailableReason: "record_unavailable"
        };
      }
    })
  );
}
