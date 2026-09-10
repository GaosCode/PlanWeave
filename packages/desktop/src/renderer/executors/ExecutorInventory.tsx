import { useState } from "react";
import type { DesktopAgentDetection, RunnerTransport } from "@planweave-ai/runtime";
import type { OperatorHostView } from "@planweave-ai/agent-host-protocol/operator-control";
import { RefreshCwIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ManagementDialog } from "../components/ManagementDialog";
import type { createTranslator } from "../i18n";
import type { RemoteAgentManagementController } from "../hooks/useRemoteAgentManagementController";
import { RemoteAgentPolicyEditor } from "../settings/RemoteAgentPolicyEditor";
import { formatHostAdministrationError } from "../settings/hostAdministrationErrors";
import { executorDisplayName } from "./executorOptionViewModel";

export function ExecutorInventory({
  agents,
  transport,
  hosts,
  remote,
  refreshing,
  onRefresh,
  onConfigure,
  t
}: {
  agents: DesktopAgentDetection[];
  transport: RunnerTransport;
  hosts: readonly OperatorHostView[];
  remote: RemoteAgentManagementController;
  refreshing: boolean;
  onRefresh: () => void;
  onConfigure: () => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = remote.agents.find((agent) => agent.endpointId === selectedId);
  const matches = (name: string) =>
    name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const local =
    location === "remote"
      ? []
      : agents.filter(
          (agent) => agent.runnerKind === transport && matches(executorDisplayName(agent.kind))
        );
  const fleet =
    location === "local"
      ? []
      : remote.agents.filter((agent) =>
          matches(
            `${agent.displayName} ${hosts.find((host) => host.id === agent.hostId)?.displayName ?? ""}`
          )
        );
  const columns =
    "grid grid-cols-[minmax(8rem,1.1fr)_minmax(8rem,1fr)_minmax(7rem,.8fr)_minmax(8rem,1fr)_5rem] items-center gap-4";
  return (
    <div className="flex flex-col gap-6" data-testid="executor-inventory">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <SearchIcon className="absolute top-2.5 left-3 size-4 text-text-muted" />
          <Input
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("executorsSearch")}
            aria-label={t("executorsSearch")}
          />
        </div>
        <select
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          aria-label={t("executorsLocationColumn")}
        >
          <option value="all">{t("executorsAllLocations")}</option>
          <option value="local">{t("executorsLocal")}</option>
          <option value="remote">{t("executorsRemote")}</option>
        </select>
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon-sm"
          aria-label={t("managementRefresh")}
          disabled={refreshing || remote.loading}
          onClick={onRefresh}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[680px]">
          <div className={`${columns} border-b border-border/70 pb-3 text-xs text-text-muted`}>
            <span>{t("executorsNavigation")}</span>
            <span>{t("executorsLocationColumn")}</span>
            <span>{t("executorsStatusColumn")}</span>
            <span>{t("executorsAccessColumn")}</span>
            <span />
          </div>
          {local.map((agent) => (
            <div
              key={`${agent.kind}-${agent.runnerKind}`}
              className={`${columns} min-h-16 border-b border-border/60 py-4 text-sm`}
              data-testid="executor-local-row"
            >
              <span className="font-medium text-text-strong">
                {executorDisplayName(agent.kind)}
              </span>
              <span className="text-text-muted">
                {t("executorsLocal")}
                {agent.executionHost?.kind === "wsl" ? " · WSL" : ""}
              </span>
              <span
                className={`flex items-center gap-2 ${agent.installed ? "text-emerald-700 dark:text-emerald-400" : "text-text-muted"}`}
              >
                <span
                  className={`size-1.5 rounded-full ${agent.installed ? "bg-emerald-500" : "bg-text-muted/40"}`}
                />
                {t(agent.installed ? "executorsReady" : "executorsNotInstalled")}
              </span>
              <span className="text-text-muted">{t("executorsLocalScope")}</span>
              <Button
                variant="ghost"
                size="sm"
                className="text-sky-700 dark:text-sky-400"
                data-testid={`executor-configure-${agent.kind}`}
                onClick={onConfigure}
              >
                {t("managementConfigure")}
              </Button>
            </div>
          ))}
          {fleet.map((agent) => {
            const host = hosts.find((item) => item.id === agent.hostId);
            const ready =
              !remote.error &&
              !agent.revokedAt &&
              !agent.ownershipRepairRequired &&
              host?.availability.status === "available";
            const label =
              remote.error || !host
                ? t("executorsDeviceUnknown")
                : agent.revokedAt
                  ? t("remoteAgentManagementRevoked")
                  : agent.ownershipRepairRequired
                    ? t("remoteAgentManagementRepairRequired")
                    : host.availability.status === "available"
                      ? t("executorsDeviceOnline")
                      : host.availability.reason
                        ? t(`hostAvailability_${host.availability.reason}`)
                        : t("executorsDeviceUnknown");
            const grants = agent.grants.map(
              (grant) =>
                remote.workspaces.find((workspace) => workspace.workspaceId === grant.workspaceId)
                  ?.displayName ?? grant.workspaceId
            );
            const scope = [
              agent.allowOwnerCanvas !== false ? t("executorsLocalScope") : null,
              agent.accessMode === "unrestricted"
                ? t("remoteAgentManagementUnrestricted")
                : grants.join(", ")
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={agent.endpointId}
                className={`${columns} min-h-16 border-b border-border/60 py-4 text-sm`}
                data-testid="executor-remote-row"
              >
                <span className="font-medium text-text-strong">{agent.displayName}</span>
                <span className="truncate text-text-muted" title={host?.displayName}>
                  {host?.displayName ?? t("remoteAgentManagementUnknownDevice")}
                </span>
                <span
                  className={`flex items-center gap-2 ${ready ? "text-emerald-700 dark:text-emerald-400" : "text-text-muted"}`}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${ready ? "bg-emerald-500" : "bg-text-muted/40"}`}
                  />
                  {label}
                </span>
                <span className="truncate text-text-muted" title={scope}>
                  {scope || t("remoteAgentManagementNoGrants")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-sky-700 dark:text-sky-400"
                  onClick={() => setSelectedId(agent.endpointId)}
                >
                  {t("managementDetails")}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
      {local.length === 0 && fleet.length === 0 && !remote.loading ? (
        <p className="text-sm text-text-muted">{t("workspaceNoResults")}</p>
      ) : null}
      {remote.loading ? (
        <p className="text-sm text-text-muted" role="status">
          {t("remoteAgentManagementLoading")}
        </p>
      ) : null}
      {remote.error ? (
        <p
          role="status"
          className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
        >
          {formatHostAdministrationError(remote.error, t)}
        </p>
      ) : !remote.operatorProfileId ? (
        <p className="text-sm text-text-muted">{t("executorsNoRemoteConnection")}</p>
      ) : null}
      <ManagementDialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        title={selected?.displayName ?? t("managementDetails")}
        t={t}
      >
        {selected ? (
          <RemoteAgentPolicyEditor
            showHeading={false}
            key={selected.endpointId}
            agent={selected}
            panel={remote}
            t={t}
          />
        ) : null}
        {remote.error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {formatHostAdministrationError(remote.error, t)}
          </p>
        ) : null}
      </ManagementDialog>
    </div>
  );
}
