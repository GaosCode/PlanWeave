import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { RotateCcwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TaskWorkspaceSelectedRun } from "../contracts";

type RetryRunApi = Partial<Pick<DesktopBridgeApi, "retryTaskWorkspaceRun">>;

function retryIdentityKey(
  identity: NonNullable<
    TaskWorkspaceSelectedRun["item"]["run"]["capabilities"]["retry"]["identity"]
  >
): string {
  return [
    identity.version,
    identity.projectId,
    identity.projectRoot,
    identity.canvasId,
    identity.taskId,
    identity.blockId,
    identity.claimRef,
    identity.recordId,
    identity.runId,
    identity.executorRunId
  ].join("\u0000");
}

export function TaskWorkspaceRetryRunAction({
  api,
  buttonLabel,
  errorLabel,
  onRetried,
  selectedRun
}: {
  api: RetryRunApi | null;
  buttonLabel: string;
  errorLabel: string;
  onRetried: () => void;
  selectedRun: TaskWorkspaceSelectedRun;
}) {
  const [request, setRequest] = useState<{
    identityKey: string;
    inFlight: boolean;
    error: string | null;
  } | null>(null);
  const capability = selectedRun.item.run.capabilities.retry;
  const identityKey = capability.identity ? retryIdentityKey(capability.identity) : null;
  const currentIdentityKey = useRef(identityKey);
  currentIdentityKey.current = identityKey;
  if (!capability.available || capability.identity === null || identityKey === null) return null;
  const identity = capability.identity;
  const inFlight = request?.identityKey === identityKey && request.inFlight;
  const error = request?.identityKey === identityKey ? request.error : null;

  const retry = () => {
    if (inFlight || !api?.retryTaskWorkspaceRun) return;
    setRequest({ identityKey, inFlight: true, error: null });
    void api
      .retryTaskWorkspaceRun(identity)
      .then(() => {
        if (currentIdentityKey.current === identityKey) onRetried();
      })
      .catch((cause: unknown) => {
        setRequest((current) =>
          current?.identityKey === identityKey
            ? {
                identityKey,
                inFlight: false,
                error: cause instanceof Error ? cause.message : String(cause)
              }
            : current
        );
      })
      .finally(() => {
        setRequest((current) =>
          current?.identityKey === identityKey ? { ...current, inFlight: false } : current
        );
      });
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button
        aria-label={buttonLabel}
        disabled={inFlight || !api?.retryTaskWorkspaceRun}
        onClick={retry}
        size="sm"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon />
        {buttonLabel}
      </Button>
      {error ? (
        <span className="max-w-48 truncate text-[11px] text-destructive" role="alert">
          {errorLabel}: {error}
        </span>
      ) : null}
    </div>
  );
}
