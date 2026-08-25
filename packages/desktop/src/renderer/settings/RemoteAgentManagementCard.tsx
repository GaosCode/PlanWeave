import { useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { createTranslator } from "../i18n";
import {
  useRemoteAgentManagementController,
  type RemoteAgentManagementController
} from "../hooks/useRemoteAgentManagementController";
import type { OperatorRemoteAgentView } from "../../shared/operatorControl";

type RemoteAgentManagementCardProps = {
  t: ReturnType<typeof createTranslator>;
  controller?: RemoteAgentManagementController;
};

export function RemoteAgentManagementCard({ t, controller }: RemoteAgentManagementCardProps) {
  const owned = useRemoteAgentManagementController();
  const panel = controller ?? owned;
  const [grantWorkspaceId, setGrantWorkspaceId] = useState<Record<string, string>>({});
  const [repairOwnerId, setRepairOwnerId] = useState<Record<string, string>>({});

  return (
    <section
      className="mt-6 flex flex-col gap-3 rounded-lg border border-border/80 p-4"
      data-testid="remote-agent-management"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-strong">
            {t("remoteAgentManagementTitle")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-text-muted">
            {t("remoteAgentManagementDescription")}
          </p>
          {panel.humanPrincipalId ? (
            <p
              className="mt-1 text-xs text-text-muted"
              data-testid="remote-agent-management-principal"
            >
              {t("remoteAgentManagementPrincipalId")}: {panel.humanPrincipalId}
            </p>
          ) : (
            <p
              className="mt-1 text-sm text-text-muted"
              data-testid="remote-agent-management-no-principal"
            >
              {t("remoteAgentManagementNoPrincipal")}
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="remote-agent-management-refresh"
          disabled={panel.busy || panel.loading || !panel.humanPrincipalId}
          onClick={() => void panel.refresh()}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {t("remoteAgentManagementRefresh")}
        </Button>
      </div>

      {panel.error ? (
        <p
          className="text-sm text-destructive"
          role="alert"
          data-testid="remote-agent-management-error"
        >
          {panel.error}
        </p>
      ) : null}

      {panel.agents.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid="remote-agent-management-empty">
          {t("remoteAgentManagementEmpty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="remote-agent-management-list">
          {panel.agents.map((agent) => (
            <RemoteAgentManagementRow
              key={agent.endpointId}
              agent={agent}
              busy={panel.busy}
              grantWorkspaceId={grantWorkspaceId[agent.endpointId] ?? ""}
              people={panel.people}
              repairOwnerId={repairOwnerId[agent.endpointId] ?? ""}
              t={t}
              onAccessModeChange={(accessMode) =>
                void panel.setAccessMode(agent.endpointId, accessMode)
              }
              onGrantWorkspaceIdChange={(value) =>
                setGrantWorkspaceId((current) => ({ ...current, [agent.endpointId]: value }))
              }
              onGrant={() => {
                const workspaceId = grantWorkspaceId[agent.endpointId]?.trim();
                if (!workspaceId) return;
                void panel.grantWorkspace(agent.endpointId, workspaceId).then((ok) => {
                  if (ok) {
                    setGrantWorkspaceId((current) => ({ ...current, [agent.endpointId]: "" }));
                  }
                });
              }}
              onRevokeGrant={(workspaceId) => void panel.revokeGrant(agent.endpointId, workspaceId)}
              onRevokeAgent={() => {
                if (!window.confirm(t("remoteAgentManagementRevokeAgentConfirm"))) return;
                void panel.revokeAgent(agent.endpointId);
              }}
              onRepairOwnerIdChange={(value) =>
                setRepairOwnerId((current) => ({ ...current, [agent.endpointId]: value }))
              }
              onRepair={() => {
                const ownerId = repairOwnerId[agent.endpointId]?.trim();
                if (!ownerId) return;
                void panel.repairOwnership(agent.endpointId, ownerId);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RemoteAgentManagementRow(input: {
  agent: OperatorRemoteAgentView;
  busy: boolean;
  grantWorkspaceId: string;
  people: RemoteAgentManagementController["people"];
  repairOwnerId: string;
  t: ReturnType<typeof createTranslator>;
  onAccessModeChange: (accessMode: OperatorRemoteAgentView["accessMode"]) => void;
  onGrantWorkspaceIdChange: (value: string) => void;
  onGrant: () => void;
  onRevokeGrant: (workspaceId: string) => void;
  onRevokeAgent: () => void;
  onRepairOwnerIdChange: (value: string) => void;
  onRepair: () => void;
}) {
  const { agent, t } = input;
  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-border/70 p-3"
      data-testid={`remote-agent-row-${agent.endpointId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-text-strong">{agent.displayName}</p>
          <p className="font-mono text-xs text-text-muted">{agent.endpointId}</p>
        </div>
        {agent.ownershipRepairRequired ? (
          <span className="text-xs text-amber-600" data-testid="remote-agent-repair-flag">
            {t("remoteAgentManagementRepairRequired")}
          </span>
        ) : null}
        {agent.revokedAt ? (
          <span className="text-xs text-text-muted">{t("remoteAgentManagementRevoked")}</span>
        ) : null}
      </div>

      {agent.ownershipRepairRequired ? (
        <div className="flex flex-col gap-2" data-testid="remote-agent-repair">
          {input.people.length > 0 ? (
            <label className="flex flex-col gap-1 text-sm">
              {t("remoteAgentManagementOwnerPicker")}
              <select
                className="rounded-md border border-border bg-background px-2 py-1"
                value={input.repairOwnerId}
                onChange={(event) => input.onRepairOwnerIdChange(event.target.value)}
              >
                <option value="">{t("remoteAgentManagementRepairOwner")}</option>
                {input.people.map((person) => (
                  <option key={person.humanPrincipalId} value={person.humanPrincipalId}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Input
            value={input.repairOwnerId}
            onChange={(event) => input.onRepairOwnerIdChange(event.target.value)}
            placeholder={t("remoteAgentManagementRepairOwner")}
            data-testid="remote-agent-repair-owner"
          />
          <Button
            type="button"
            size="sm"
            disabled={input.busy || !input.repairOwnerId.trim()}
            onClick={input.onRepair}
          >
            {t("remoteAgentManagementRepairSubmit")}
          </Button>
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            {t("remoteAgentManagementAccessMode")}
            <select
              className="rounded-md border border-border bg-background px-2 py-1"
              value={agent.accessMode}
              disabled={input.busy || Boolean(agent.revokedAt)}
              data-testid="remote-agent-access-mode"
              onChange={(event) =>
                input.onAccessModeChange(
                  event.target.value as OperatorRemoteAgentView["accessMode"]
                )
              }
            >
              <option value="unrestricted">{t("remoteAgentManagementUnrestricted")}</option>
              <option value="workspace_restricted">
                {t("remoteAgentManagementWorkspaceRestricted")}
              </option>
            </select>
          </label>

          <div>
            <p className="text-sm font-medium">{t("remoteAgentManagementGrants")}</p>
            {agent.grants.length === 0 ? (
              <p className="text-xs text-text-muted">{t("remoteAgentManagementNoGrants")}</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {agent.grants.map((grant) => (
                  <li
                    key={grant.workspaceId}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="font-mono">{grant.workspaceId}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={input.busy}
                      onClick={() => input.onRevokeGrant(grant.workspaceId)}
                    >
                      {t("remoteAgentManagementRevokeGrant")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <Input
                value={input.grantWorkspaceId}
                onChange={(event) => input.onGrantWorkspaceIdChange(event.target.value)}
                placeholder={t("remoteAgentManagementWorkspaceId")}
                data-testid="remote-agent-grant-workspace"
              />
              <Button
                type="button"
                size="sm"
                disabled={input.busy || !input.grantWorkspaceId.trim()}
                onClick={input.onGrant}
              >
                {t("remoteAgentManagementAddGrant")}
              </Button>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={input.busy || Boolean(agent.revokedAt)}
            onClick={input.onRevokeAgent}
          >
            {t("remoteAgentManagementRevokeAgent")}
          </Button>
        </>
      )}
    </li>
  );
}
