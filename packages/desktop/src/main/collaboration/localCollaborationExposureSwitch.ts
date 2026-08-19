import type { DesktopServerExposureView } from "../../shared/deploymentExposure.js";
import { desktopServerExposureModeInputSchema } from "../../shared/deploymentExposure.js";

type ExposureControlPort = {
  getExposureView(): DesktopServerExposureView;
  setExposureMode(input: unknown): Promise<DesktopServerExposureView>;
  localProfile(): { profileId: string } | null;
};

type LocalActivationPort = {
  reconcile(previousProfileId?: string): Promise<unknown>;
  rememberThisComputerAsLastServer?(): Promise<void>;
};

function sameExposureAuthority(
  restored: DesktopServerExposureView,
  previous: DesktopServerExposureView
): boolean {
  return (
    restored.mode === previous.mode &&
    restored.lifecycle === previous.lifecycle &&
    restored.topology === previous.topology &&
    restored.advertisedOrigin === previous.advertisedOrigin &&
    restored.canInvite === previous.canInvite
  );
}

export async function restorePreviousAuthority(
  local: ExposureControlPort,
  activation: LocalActivationPort,
  previous: DesktopServerExposureView,
  previousProfileId: string | undefined
): Promise<DesktopServerExposureView> {
  const restored = await local.setExposureMode({ mode: previous.mode });
  if (restored.lifecycle === "error" || !sameExposureAuthority(restored, previous)) {
    throw new Error("local_collaboration_exposure_rollback_authority_mismatch");
  }
  await activation.reconcile(previousProfileId);
  return restored;
}

export async function switchLocalCollaborationExposure(
  local: ExposureControlPort,
  activation: LocalActivationPort,
  input: unknown
): Promise<DesktopServerExposureView> {
  const parsed = desktopServerExposureModeInputSchema.parse(input);
  const previous = local.getExposureView();
  const previousProfileId = local.localProfile()?.profileId;
  const next = await local.setExposureMode(parsed);
  if (next.mode !== parsed.mode) return next;
  if (next.lifecycle === "error") {
    if (parsed.mode === "custom_https") return next;
    try {
      await restorePreviousAuthority(local, activation, previous, previousProfileId);
    } catch (rollbackError) {
      throw new AggregateError(
        [
          new Error(next.errorCode ?? "local_collaboration_exposure_activation_failed"),
          rollbackError
        ],
        "local_collaboration_exposure_rollback_failed"
      );
    }
    return next;
  }
  try {
    await activation.rememberThisComputerAsLastServer?.();
    await activation.reconcile(previousProfileId);
    return next;
  } catch (error) {
    try {
      await restorePreviousAuthority(local, activation, previous, previousProfileId);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "local_collaboration_exposure_rollback_failed"
      );
    }
    throw error;
  }
}
