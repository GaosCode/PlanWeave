import { useState } from "react";
import { ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { createTranslator } from "../i18n";
import type { RemoteAgentManagementController } from "../hooks/useRemoteAgentManagementController";
import type { OperatorRemoteAgentView } from "../../shared/operatorControl";

export function RemoteAgentPolicyEditor({
  agent,
  panel,
  t,
  showHeading = true
}: {
  agent: OperatorRemoteAgentView;
  panel: RemoteAgentManagementController;
  t: ReturnType<typeof createTranslator>;
  showHeading?: boolean;
}) {
  const [repairOwnerId, setRepairOwnerId] = useState("");
  const disabled = panel.busy || Boolean(agent.revokedAt);
  const grantedIds = new Set(agent.grants.map((grant) => grant.workspaceId));
  const workspaces = [
    ...panel.workspaces,
    ...agent.grants
      .filter(
        (grant) =>
          !panel.workspaces.some((workspace) => workspace.workspaceId === grant.workspaceId)
      )
      .map((grant) => ({ workspaceId: grant.workspaceId, displayName: grant.workspaceId }))
  ];
  return (
    <section
      className="flex flex-col gap-6 py-2"
      data-testid={`remote-agent-row-${agent.endpointId}`}
    >
      {showHeading ? <h3 className="font-medium">{agent.displayName}</h3> : null}
      {agent.revokedAt ? (
        <p className="text-sm text-text-muted">{t("remoteAgentManagementRevoked")}</p>
      ) : null}
      {agent.ownershipRepairRequired ? (
        <div className="flex flex-col gap-3" data-testid="remote-agent-repair">
          <p
            className="rounded-md bg-amber-500/10 p-3 text-sm"
            data-testid="remote-agent-repair-flag"
          >
            {t("remoteAgentManagementRepairRequired")}
          </p>
          {panel.people.length > 0 ? (
            <Select value={repairOwnerId} onValueChange={setRepairOwnerId}>
              <SelectTrigger aria-label={t("remoteAgentManagementOwnerPicker")}>
                <SelectValue placeholder={t("remoteAgentManagementRepairOwner")} />
              </SelectTrigger>
              <SelectContent>
                {panel.people.map((person) => (
                  <SelectItem key={person.humanPrincipalId} value={person.humanPrincipalId}>
                    {person.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={repairOwnerId}
              onChange={(event) => setRepairOwnerId(event.target.value)}
              placeholder={t("remoteAgentManagementRepairOwner")}
              data-testid="remote-agent-repair-owner"
            />
          )}
          <Button
            size="sm"
            className="self-start"
            disabled={panel.busy || !repairOwnerId.trim()}
            onClick={() => void panel.repairOwnership(agent.endpointId, repairOwnerId.trim())}
          >
            {t("remoteAgentManagementRepairSubmit")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-6 border-b border-border/70 pb-5">
            <div>
              <label className="text-sm font-medium" htmlFor={`owner-canvas-${agent.endpointId}`}>
                {t("remoteAgentManagementLocalCanvas")}
              </label>
              <p className="mt-1 text-xs text-text-muted">{t("executorOwnerCanvasHint")}</p>
            </div>
            <Switch
              id={`owner-canvas-${agent.endpointId}`}
              checked={agent.allowOwnerCanvas !== false}
              disabled={disabled}
              data-testid="remote-agent-local-canvas"
              onCheckedChange={(allow) =>
                void panel.setAccessMode(agent.endpointId, agent.accessMode, allow)
              }
            />
          </div>
          <fieldset disabled={disabled} className="min-w-0" data-testid="remote-agent-access-mode">
            <legend className="mb-3 flex items-center gap-2 text-sm font-medium">
              <ShieldCheckIcon className="size-4 text-text-muted" />
              {t("remoteAgentManagementAccessMode")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["unrestricted", "workspace_restricted"] as const).map((mode) => (
                <label
                  key={mode}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 ${agent.accessMode === mode ? "border-sky-500/50 bg-sky-500/5" : "border-border hover:bg-muted/40"}`}
                >
                  <input
                    type="radio"
                    className="mt-1 accent-sky-600"
                    name={`access-${agent.endpointId}`}
                    value={mode}
                    checked={agent.accessMode === mode}
                    onChange={() =>
                      void panel.setAccessMode(
                        agent.endpointId,
                        mode,
                        agent.allowOwnerCanvas !== false
                      )
                    }
                  />
                  <span>
                    <span className="text-sm font-medium">
                      {t(
                        mode === "unrestricted"
                          ? "remoteAgentManagementUnrestricted"
                          : "remoteAgentManagementWorkspaceRestricted"
                      )}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-text-muted">
                      {t(
                        mode === "unrestricted"
                          ? "executorUnrestrictedHint"
                          : "executorRestrictedHint"
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {agent.accessMode === "workspace_restricted" ? (
            <div
              className="rounded-lg border border-border px-4"
              data-testid="remote-agent-grant-workspace"
            >
              {workspaces.length ? (
                workspaces.map((workspace) => (
                  <div
                    key={workspace.workspaceId}
                    className="flex items-center justify-between gap-4 border-b border-border/60 py-3 last:border-0"
                  >
                    <label
                      htmlFor={`grant-${agent.endpointId}-${workspace.workspaceId}`}
                      className="truncate text-sm"
                    >
                      {workspace.displayName}
                    </label>
                    <Switch
                      id={`grant-${agent.endpointId}-${workspace.workspaceId}`}
                      checked={grantedIds.has(workspace.workspaceId)}
                      disabled={disabled}
                      onCheckedChange={(allow) =>
                        void (allow
                          ? panel.grantWorkspace(agent.endpointId, workspace.workspaceId)
                          : panel.revokeGrant(agent.endpointId, workspace.workspaceId))
                      }
                    />
                  </div>
                ))
              ) : (
                <p className="py-4 text-xs text-text-muted">{t("remoteAgentManagementNoGrants")}</p>
              )}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4 border-t border-border/70 pt-4">
            <details className="min-w-0 text-xs text-text-muted">
              <summary className="cursor-pointer">{t("executorTechnicalDetails")}</summary>
              <code className="mt-2 block break-all">{agent.endpointId}</code>
            </details>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="shrink-0 text-destructive"
              disabled={disabled}
              onClick={() => {
                if (window.confirm(t("remoteAgentManagementRevokeAgentConfirm")))
                  void panel.revokeAgent(agent.endpointId);
              }}
            >
              {t("remoteAgentManagementRevokeAgent")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
