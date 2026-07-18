import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { HistoryIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TaskWorkspaceSelectedRun } from "../contracts";

type RecoverAcpRunApi = Partial<Pick<DesktopBridgeApi, "recoverTaskWorkspaceAcpRun">>;

function recoveryIdentityKey(
  identity: NonNullable<
    TaskWorkspaceSelectedRun["item"]["run"]["capabilities"]["recoverAcpSession"]["identity"]
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
    identity.sessionId,
    identity.terminalEventSequence,
    identity.agentId,
    identity.executorProfile,
    identity.launch.command,
    ...identity.launch.args
  ].join("\u0000");
}

export function TaskWorkspaceRecoverAcpRunAction({
  api,
  buttonLabel,
  errorLabel,
  onRecovered,
  selectedRun
}: {
  api: RecoverAcpRunApi | null;
  buttonLabel: string;
  errorLabel: string;
  onRecovered: () => void;
  selectedRun: TaskWorkspaceSelectedRun;
}) {
  const [request, setRequest] = useState<{
    identityKey: string;
    inFlight: boolean;
    error: string | null;
  } | null>(null);
  const capability = selectedRun.item.run.capabilities.recoverAcpSession;
  const identityKey = capability.identity ? recoveryIdentityKey(capability.identity) : null;
  const currentIdentityKey = useRef(identityKey);
  currentIdentityKey.current = identityKey;
  if (!capability.available || capability.identity === null || identityKey === null) return null;
  const identity = capability.identity;
  const inFlight = request?.identityKey === identityKey && request.inFlight;
  const error = request?.identityKey === identityKey ? request.error : null;

  const recover = () => {
    if (inFlight || !api?.recoverTaskWorkspaceAcpRun) return;
    setRequest({ identityKey, inFlight: true, error: null });
    void api
      .recoverTaskWorkspaceAcpRun(identity, {
        source: "planweave-desktop",
        reason: "User requested recovery of an interrupted ACP session."
      })
      .then(() => {
        if (currentIdentityKey.current === identityKey) onRecovered();
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
        disabled={inFlight || !api?.recoverTaskWorkspaceAcpRun}
        onClick={recover}
        size="sm"
        type="button"
        variant="outline"
      >
        <HistoryIcon />
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
