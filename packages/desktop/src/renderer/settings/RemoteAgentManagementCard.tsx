import type { OperatorHostView } from "@planweave-ai/agent-host-protocol/operator-control";
import { useMemo, useState } from "react";
import { ChevronRightIcon, MonitorIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RemoteAgentPolicyEditor } from "./RemoteAgentPolicyEditor";
import type { createTranslator } from "../i18n";
import {
  useRemoteAgentManagementController,
  type RemoteAgentManagementController
} from "../hooks/useRemoteAgentManagementController";
import type { OperatorRemoteAgentView } from "../../shared/operatorControl";
import { formatHostAdministrationError } from "./hostAdministrationErrors";

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
          {formatHostAdministrationError(panel.error, t)}
        </p>
      ) : null}

      {panel.loading ? (
        <p className="text-sm text-text-muted" role="status">
          {t("remoteAgentManagementLoading")}
        </p>
      ) : null}

      {devices.length === 0 &&
      !panel.loading &&
      !panel.error &&
      panel.humanPrincipalId &&
      panel.operatorProfileId ? (
        <p className="text-sm text-text-muted" data-testid="remote-agent-management-empty">
          {t("remoteAgentManagementEmpty")}
        </p>
      ) : null}
      {devices.length > 0 ? (
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
              <div
                className="divide-y divide-border/70 px-4"
                data-testid="remote-agent-management-list"
              >
                {selectedDevice.agents.map((agent) => (
                  <RemoteAgentPolicyEditor
                    key={agent.endpointId}
                    agent={agent}
                    panel={panel}
                    t={t}
                  />
                ))}
              </div>
            ) : (
              <p className="px-4 py-6 text-sm text-text-muted">
                {t("remoteAgentManagementNoAgentsForDevice")}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
