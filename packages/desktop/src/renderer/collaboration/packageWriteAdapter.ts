import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { WorkspaceCanvasCommandsResult } from "../hooks/useWorkspaceCanvasCommands";

/**
 * Shared-mode package write gate.
 * When `enabled`, durable graph/package mutations must submit typed canvas command
 * intents and refresh from authoritative state — never call local package writers.
 */
export type WorkspacePackageWriteGate = WorkspaceCanvasCommandsResult | null | undefined;

export type DurablePackageWriteResult = "shared" | "local" | "failed";

/**
 * Route one durable mutation: shared command path when connected, else local bridge write.
 * Guarantees the local writer is not invoked while `workspaceCanvas.enabled` is true.
 */
export async function runDurablePackageWrite(options: {
  workspaceCanvas: WorkspacePackageWriteGate;
  intent: CanvasCommandIntent;
  onError?: (message: string | null) => void;
  localWrite: () => Promise<void>;
}): Promise<DurablePackageWriteResult> {
  if (options.workspaceCanvas?.enabled) {
    const result = await options.workspaceCanvas.submit({ intent: options.intent });
    if (!result.ok) {
      options.onError?.(result.error);
      return "failed";
    }
    return "shared";
  }
  await options.localWrite();
  return "local";
}

/**
 * For mutations that lack a canvas command intent: refuse local package writes while shared.
 * Callers must not fall through to bridge package writers when this returns "shared_blocked".
 */
export async function runLocalOnlyWhenOffline(options: {
  workspaceCanvas: WorkspacePackageWriteGate;
  onError?: (message: string | null) => void;
  unsupportedMessage: string;
  localWrite: () => Promise<void>;
}): Promise<"local" | "shared_blocked" | "failed"> {
  if (options.workspaceCanvas?.enabled) {
    options.onError?.(options.unsupportedMessage);
    return "shared_blocked";
  }
  try {
    await options.localWrite();
    return "local";
  } catch (error) {
    options.onError?.(error instanceof Error ? error.message : String(error));
    return "failed";
  }
}

/** Submit a shared intent only; returns false when shared mode is off or submit fails. */
export async function submitSharedPackageIntent(
  workspaceCanvas: WorkspacePackageWriteGate,
  intent: CanvasCommandIntent,
  onError?: (message: string | null) => void
): Promise<boolean> {
  if (!workspaceCanvas?.enabled) {
    return false;
  }
  const result = await workspaceCanvas.submit({ intent });
  if (!result.ok) {
    onError?.(result.error);
    return false;
  }
  return true;
}
