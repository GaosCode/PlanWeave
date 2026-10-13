import type { DesktopProjectSummary, DesktopWatchRegistration } from "@planweave-ai/runtime";
import { desktopWatchRegistrationSchema } from "@planweave-ai/runtime/browser";

const registrations = new Map<string, DesktopWatchRegistration>();
const watchEventIdentitySchema = desktopWatchRegistrationSchema.strip();

export function beginDesktopWatchRegistration(
  project: Pick<DesktopProjectSummary, "rootPath" | "workspaceRoot">,
  canvasId: string | null
) {
  const reference: DesktopWatchRegistration = {
    projectRoot: project.rootPath,
    workspaceRoot: project.workspaceRoot,
    canvasId,
    registrationId: crypto.randomUUID()
  };
  registrations.set(reference.registrationId, reference);
  return {
    reference,
    retire() {
      registrations.delete(reference.registrationId);
    }
  };
}

/** Every consumer receives only events belonging to a live registration in this renderer. */
export function isActiveDesktopWatchEvent(event: unknown): boolean {
  const parsed = watchEventIdentitySchema.safeParse(event);
  if (!parsed.success) return false;
  const reference = registrations.get(parsed.data.registrationId);
  return Boolean(
    reference &&
      reference.projectRoot === parsed.data.projectRoot &&
      reference.workspaceRoot === parsed.data.workspaceRoot &&
      (reference.canvasId ?? null) === (parsed.data.canvasId ?? null)
  );
}
