import type {
  DesktopBridgeApi,
  DesktopCanvasReference,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { SquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useRunnerInterventions } from "../../hooks/useRunnerInterventions";
import type { TaskWorkspaceSelectedRun } from "../contracts";
import { sameSessionActionIdentity } from "./actionIdentity";

type CancelRunApi = Partial<Pick<DesktopBridgeApi, "cancelAgentRun">>;

export type TaskWorkspaceCancelRunController = {
  actionError: string | null;
  available: boolean;
  cancel: () => void;
  inFlight: boolean;
};

const unavailableCancelRunController: TaskWorkspaceCancelRunController = {
  actionError: null,
  available: false,
  cancel: () => undefined,
  inFlight: false
};

export function TaskWorkspaceCancelRunControllerScope({
  api,
  canvasRef,
  children,
  model,
  selectedRun
}: {
  api: CancelRunApi | null;
  canvasRef: DesktopCanvasReference | null;
  children: (controller: TaskWorkspaceCancelRunController) => ReactNode;
  model: RunnerRecordReadModel | null;
  selectedRun: TaskWorkspaceSelectedRun | null;
}) {
  const interventions = useRunnerInterventions({
    api,
    canvasRef,
    model,
    recordId: selectedRun?.item.run.record.recordId ?? null
  });
  if (!model || !selectedRun) return children(unavailableCancelRunController);
  const selectedCapability = selectedRun.item.run.capabilities.cancel;
  const liveCapability = model.intervention.cancel;
  const identity = sameSessionActionIdentity(liveCapability.identity, selectedCapability.identity)
    ? liveCapability.identity
    : null;
  const available = liveCapability.available && selectedCapability.available && identity !== null;

  return children({
    actionError: interventions.actionError?.message ?? null,
    available,
    cancel: () => {
      if (identity) interventions.cancel(identity);
    },
    inFlight: interventions.cancelInFlight
  });
}

export function TaskWorkspaceCancelRunAction({
  buttonLabel,
  controller,
  errorLabel,
  showText = false
}: {
  buttonLabel: string;
  controller: TaskWorkspaceCancelRunController;
  errorLabel: string;
  showText?: boolean;
}) {
  if (!controller.available) return null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button
        aria-label={buttonLabel}
        disabled={controller.inFlight}
        onClick={controller.cancel}
        size={showText ? "sm" : "icon-sm"}
        type="button"
        variant="destructive"
      >
        <SquareIcon />
        {showText ? buttonLabel : null}
      </Button>
      {controller.actionError ? (
        <span className="max-w-48 truncate text-[11px] text-destructive" role="alert">
          {errorLabel}: {controller.actionError}
        </span>
      ) : null}
    </div>
  );
}
