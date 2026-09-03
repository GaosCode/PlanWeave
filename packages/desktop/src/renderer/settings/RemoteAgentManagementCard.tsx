import type { OperatorHostView } from "@planweave-ai/agent-host-protocol/operator-control";
import { useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, MonitorIcon, RefreshCwIcon } from "lucide-react";
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
  hosts?: readonly OperatorHostView[];
};

type RemoteAgentDeviceGroup = {
  hostId: string;
  host: OperatorHostView | null;
  agents: OperatorRemoteAgentView[];
};

export function buildRemoteAgentDeviceGroups(input: {
  agents: readonly OperatorRemoteAgentView[];
  hosts: readonly OperatorHostView[];
}): RemoteAgentDeviceGroup[] {
  const hostsById = new Map(input.hosts.map((host) => [host.id, host]));
  const groups = new Map<string, RemoteAgentDeviceGroup>();
  for (const agent of input.agents) {
    const group = groups.get(agent.hostId) ?? {
      hostId: agent.hostId,
      host: hostsById.get(agent.hostId) ?? null,
      agents: []
    };
    group.agents.push(agent);
    groups.set(agent.hostId, group);
  }
  return [...groups.values()].sort((left, right) => {
    const leftLabel = left.host?.displayName ?? left.hostId;
    const rightLabel = right.host?.displayName ?? right.hostId;
    return leftLabel.localeCompare(rightLabel);
  });
}

export function RemoteAgentManagementCard({
  t,
  controller,
  hosts = []
}: RemoteAgentManagementCardProps) {
  const owned = useRemoteAgentManagementController();
  const panel = controller ?? owned;
  const [grantWorkspaceId, setGrantWorkspaceId] = useState<Record<string, string>>({});
  const [repairOwnerId, setRepairOwnerId] = useState<Record<string, string>>({});
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const devices = useMemo(
    () => buildRemoteAgentDeviceGroups({ agents: panel.agents, hosts }),
    [hosts, panel.agents]
  );
  const selectedDevice =
    devices.find((device) => device.hostId === selectedHostId) ??
    devices.find((device) => device.agents.length > 0) ??
    devices[0] ??
    null;

  return (
    <section className="flex flex-col gap-4 py-8" data-testid="remote-agent-management">
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

      {devices.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid="remote-agent-management-empty">
          {t("remoteAgentManagementEmpty")}
        </p>
      ) : (
        <div className="grid min-h-64 overflow-hidden border-y border-border/80 md:grid-cols-[minmax(14rem,0.72fr)_minmax(0,1.28fr)]">
          <nav className="border-b border-border/80 bg-surface-muted/30 md:border-r md:border-b-0">
            <p className="px-3 pt-3 pb-2 text-[0.6875rem] font-semibold tracking-[0.12em] text-text-muted uppercase">
              {t("remoteAgentManagementDevices")}
            </p>
            <ul className="divide-y divide-border/60" data-testid="remote-agent-device-list">
              {devices.map((device) => {
                const selected = device.hostId === selectedDevice?.hostId;
                return (
                  <li key={device.hostId}>
                    <button
                      type="button"
                      className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 px-3 py-3 text-left transition-colors ${
                        selected
                          ? "bg-background text-text-strong"
                          : "text-text-muted hover:bg-background/70 hover:text-text-strong"
                      }`}
                      aria-current={selected ? "true" : undefined}
                      data-testid={`remote-agent-device-${device.hostId}`}
                      onClick={() => setSelectedHostId(device.hostId)}
                    >
                      <span className="relative">
                        <MonitorIcon className="size-4" aria-hidden="true" />
                        <span
                          className={`absolute -right-1 -bottom-1 size-2 rounded-full border border-background ${
                            device.host?.online ? "bg-emerald-500" : "bg-text-muted/40"
                          }`}
                        />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {device.host?.displayName ?? t("remoteAgentManagementUnknownDevice")}
                        </span>
                      </span>
                      <span className="flex items-center gap-1 text-xs tabular-nums">
                        {device.agents.length}
                        <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 bg-background">
            <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-strong">
                  {selectedDevice?.host?.displayName ?? t("remoteAgentManagementUnknownDevice")}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {t("remoteAgentManagementExposedAgents")}: {selectedDevice?.agents.length ?? 0}
                </p>
              </div>
              {selectedDevice?.host ? (
                <span
                  className={`text-xs ${selectedDevice.host.online ? "text-emerald-600" : "text-text-muted"}`}
                >
                  {selectedDevice.host.online
                    ? t("remoteAgentManagementDeviceOnline")
                    : t("remoteAgentManagementDeviceOffline")}
                </span>
              ) : null}
            </div>
            {selectedDevice && selectedDevice.agents.length > 0 ? (
              <ul className="divide-y divide-border/70" data-testid="remote-agent-management-list">
                {selectedDevice.agents.map((agent) => (
                  <RemoteAgentManagementRow
                    key={agent.endpointId}
                    agent={agent}
                    busy={panel.busy}
                    grantWorkspaceId={grantWorkspaceId[agent.endpointId] ?? ""}
                    people={panel.people}
                    workspaces={panel.workspaces}
                    repairOwnerId={repairOwnerId[agent.endpointId] ?? ""}
                    t={t}
                    onAccessModeChange={(accessMode) =>
                      void panel.setAccessMode(
                        agent.endpointId,
                        accessMode,
                        agent.allowOwnerCanvas !== false
                      )
                    }
                    onAllowOwnerCanvasChange={(allowOwnerCanvas) =>
                      void panel.setAccessMode(agent.endpointId, agent.accessMode, allowOwnerCanvas)
                    }
                    onGrantWorkspaceIdChange={(value) =>
                      setGrantWorkspaceId((current) => ({
                        ...current,
                        [agent.endpointId]: value
                      }))
                    }
                    onGrant={() => {
                      const workspaceId = grantWorkspaceId[agent.endpointId]?.trim();
                      if (!workspaceId) return;
                      void panel.grantWorkspace(agent.endpointId, workspaceId).then((ok) => {
                        if (ok) {
                          setGrantWorkspaceId((current) => ({
                            ...current,
                            [agent.endpointId]: ""
                          }));
                        }
                      });
                    }}
                    onRevokeGrant={(workspaceId) =>
                      void panel.revokeGrant(agent.endpointId, workspaceId)
                    }
                    onRevokeAgent={() => {
                      if (!window.confirm(t("remoteAgentManagementRevokeAgentConfirm"))) return;
                      void panel.revokeAgent(agent.endpointId);
                    }}
                    onRepairOwnerIdChange={(value) =>
                      setRepairOwnerId((current) => ({
                        ...current,
                        [agent.endpointId]: value
                      }))
                    }
                    onRepair={() => {
                      const ownerId = repairOwnerId[agent.endpointId]?.trim();
                      if (!ownerId) return;
                      void panel.repairOwnership(agent.endpointId, ownerId);
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-text-muted">
                {t("remoteAgentManagementNoAgentsForDevice")}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function workspaceLabel(
  workspaceId: string,
  workspaces: RemoteAgentManagementController["workspaces"]
): string {
  return (
    workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.displayName ??
    workspaceId
  );
}

function RemoteAgentManagementRow(input: {
  agent: OperatorRemoteAgentView;
  busy: boolean;
  grantWorkspaceId: string;
  people: RemoteAgentManagementController["people"];
  workspaces: RemoteAgentManagementController["workspaces"];
  repairOwnerId: string;
  t: ReturnType<typeof createTranslator>;
  onAccessModeChange: (accessMode: OperatorRemoteAgentView["accessMode"]) => void;
  onAllowOwnerCanvasChange: (allowOwnerCanvas: boolean) => void;
  onGrantWorkspaceIdChange: (value: string) => void;
  onGrant: () => void;
  onRevokeGrant: (workspaceId: string) => void;
  onRevokeAgent: () => void;
  onRepairOwnerIdChange: (value: string) => void;
  onRepair: () => void;
}) {
  const { agent, t } = input;
  const grantedIds = new Set(agent.grants.map((grant) => grant.workspaceId));
  const grantableWorkspaces = input.workspaces.filter(
    (workspace) => !grantedIds.has(workspace.workspaceId)
  );
  const header = (
    <>
      <div className="min-w-0">
        <p className="truncate font-medium text-text-strong">{agent.displayName}</p>
        <p className="truncate font-mono text-xs text-text-muted">{agent.endpointId}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {agent.ownershipRepairRequired ? (
          <span className="text-xs text-amber-600" data-testid="remote-agent-repair-flag">
            {t("remoteAgentManagementRepairRequired")}
          </span>
        ) : null}
        {agent.revokedAt ? (
          <span className="text-xs text-text-muted">{t("remoteAgentManagementRevoked")}</span>
        ) : null}
      </div>
    </>
  );

  return (
    <li data-testid={`remote-agent-row-${agent.endpointId}`}>
      {agent.ownershipRepairRequired ? (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex items-start justify-between gap-2">{header}</div>
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
        </div>
      ) : (
        <details className="group">
          <summary
            className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 marker:content-none"
            data-testid={`remote-agent-row-toggle-${agent.endpointId}`}
            aria-label={`${agent.displayName}, ${t("remoteAgentManagementPermissions")}`}
          >
            <div className="flex min-w-0 flex-1 items-start justify-between gap-2">{header}</div>
            <ChevronDownIcon
              className="mt-1 size-4 shrink-0 text-text-muted transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="flex flex-col gap-3 px-4 pb-3">
            <label className="flex flex-col gap-1 text-sm">
              {t("remoteAgentManagementLocalCanvas")}
              <select
                className="rounded-md border border-border bg-background px-2 py-1"
                value={agent.allowOwnerCanvas === false ? "deny" : "allow"}
                disabled={input.busy || Boolean(agent.revokedAt)}
                data-testid="remote-agent-local-canvas"
                onChange={(event) => input.onAllowOwnerCanvasChange(event.target.value === "allow")}
              >
                <option value="allow">{t("remoteAgentManagementLocalCanvasAllow")}</option>
                <option value="deny">{t("remoteAgentManagementLocalCanvasDeny")}</option>
              </select>
            </label>
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
                      <span>{workspaceLabel(grant.workspaceId, input.workspaces)}</span>
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
              {grantableWorkspaces.length === 0 ? (
                <p className="mt-2 text-xs text-text-muted">
                  {t("remoteAgentManagementNoCanvases")}
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <select
                    className="min-w-48 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={input.grantWorkspaceId}
                    disabled={input.busy || Boolean(agent.revokedAt)}
                    data-testid="remote-agent-grant-workspace"
                    aria-label={t("remoteAgentManagementWorkspaceId")}
                    onChange={(event) => input.onGrantWorkspaceIdChange(event.target.value)}
                  >
                    <option value="">{t("remoteAgentManagementWorkspaceId")}</option>
                    {grantableWorkspaces.map((workspace) => (
                      <option key={workspace.workspaceId} value={workspace.workspaceId}>
                        {workspace.displayName}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="sm"
                    disabled={input.busy || !input.grantWorkspaceId.trim()}
                    onClick={input.onGrant}
                  >
                    {t("remoteAgentManagementAddGrant")}
                  </Button>
                </div>
              )}
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
          </div>
        </details>
      )}
    </li>
  );
}
