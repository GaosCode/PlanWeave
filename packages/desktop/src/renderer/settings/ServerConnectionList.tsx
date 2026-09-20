import { useEffect, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { RememberedServerConnectionView } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import type { createTranslator } from "../i18n";
import { collaborationConnectionErrorMessage } from "../collaboration/formatCollaborationError";
import { serverDeploymentLabel } from "./serverDeploymentLabel";
import { rememberedServerGroups } from "./rememberedServerGroups";

export function ServerConnectionList({
  refreshKey,
  t
}: {
  refreshKey: number;
  t: ReturnType<typeof createTranslator>;
}) {
  const { status, refresh } = useCollaborationStatus();
  const [servers, setServers] = useState<RememberedServerConnectionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [checks, setChecks] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection changes and completed actions invalidate the saved connection list.
  useEffect(() => {
    const api = collaborationBridge;
    if (!api) {
      setLoading(false);
      return;
    }
    let current = true;
    setError(null);
    setLoading(true);
    void api.listRememberedServerConnections().then(
      (connections) => {
        if (!current) return;
        setLoading(false);
        setServers(connections);
      },
      (cause: unknown) => {
        if (current) {
          setLoading(false);
          setError(collaborationConnectionErrorMessage(t, cause));
        }
      }
    );
    return () => {
      current = false;
    };
  }, [refreshKey, epoch, status?.workspaceConnection.profile?.profileId, t]);
  const operate = async (
    server: RememberedServerConnectionView,
    action: "connect" | "forget" | "check"
  ) => {
    const api = collaborationBridge;
    if (!api) return;
    if (
      action === "forget" &&
      !window.confirm(
        `${t("serverForgetConfirm")}\n${server.serverBaseUrl}\n${server.workspaceDisplayName} · ${server.profileId}`
      )
    )
      return;
    if (
      action === "connect" &&
      server.profileId === status?.workspaceConnection.profile?.profileId &&
      status.workspaceConnection.status === "connected"
    )
      return;
    setBusy(server.profileId);
    setError(null);
    try {
      if (action === "connect")
        await api.selectWorkspaceConnection({ profileId: server.profileId });
      else if (action === "forget")
        await api.forgetRememberedServerConnection({ profileId: server.profileId });
      else {
        const result = await api.validateDeploymentConnectivity({
          action: "validate_connectivity",
          target: {
            schemaVersion: "deployment-target-draft/v1",
            displayName: server.displayName,
            endpoint: server.endpoint,
            capabilities: ["deployment_guidance", "connectivity_validation"]
          }
        });
        const keys = {
          reachable: "deploymentConnectivityReachable",
          invalid_tls: "deploymentConnectivityTls",
          invalid_origin: "deploymentConnectivityOrigin",
          invalid_configuration: "deploymentConnectivityConfiguration",
          unreachable: "deploymentConnectivityUnreachable"
        } as const;
        setChecks((current) => ({ ...current, [server.profileId]: t(keys[result.status]) }));
      }
      await refresh();
      setEpoch((value) => value + 1);
    } catch (cause) {
      setError(collaborationConnectionErrorMessage(t, cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-6" data-testid="server-connection-list">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_1fr_.7fr_11rem] gap-4 border-b border-border/70 pb-3 text-xs text-text-muted">
            <span>{t("serverSavedConnections")}</span>
            <span>{t("deploymentOrigin")}</span>
            <span>{t("serverDeploymentMethod")}</span>
            <span>{t("executorsStatusColumn")}</span>
            <span />
          </div>
          {rememberedServerGroups(
            servers,
            status?.workspaceConnection.profile?.profileId ?? null
          ).map((group) => {
            const server = group.primary;
            const active = group.connections.some(
              (connection) =>
                connection.profileId === status?.workspaceConnection.profile?.profileId
            );
            const connecting = active && status?.workspaceConnection.status === "connecting";
            const connected = active && status?.workspaceConnection.status === "connected";
            return (
              <div
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_1fr_.7fr_11rem] items-center gap-4 border-b border-border/60 py-5 text-sm"
                key={group.origin}
                data-testid="server-connection-row"
              >
                <span
                  className="truncate font-medium text-text-strong"
                  title={new URL(group.origin).host}
                >
                  {new URL(group.origin).host}
                </span>
                <span className="truncate text-text-muted" title={server.serverBaseUrl}>
                  {server.serverBaseUrl}
                </span>
                <span className="text-text-muted" data-testid="server-deployment-method">
                  {serverDeploymentLabel(server.endpoint, t)}
                </span>
                <span className="flex items-center gap-2 text-text-muted">
                  <span
                    className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : active ? "bg-amber-500" : "bg-text-muted/40"}`}
                  />
                  {connected
                    ? t("settingsServerConnected")
                    : connecting
                      ? t("settingsServerRemoteConnecting")
                      : active
                        ? t("settingsServerRemoteError")
                        : t("serverRemembered")}
                </span>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!connected && group.connections.length > 1) setOpenMenu(group.origin);
                      else void operate(server, connected ? "check" : "connect");
                    }}
                  >
                    {t(connected ? "settingsServerCheckConnectivity" : "settingsServerConnect")}
                  </Button>
                  <DropdownMenu
                    open={openMenu === group.origin}
                    onOpenChange={(open) => setOpenMenu(open ? group.origin : null)}
                  >
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`${t("managementActions")}: ${new URL(group.origin).host}`}
                        disabled={busy !== null}
                      >
                        <EllipsisIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-80">
                      <DropdownMenuLabel>{t("serverWorkspaceConnections")}</DropdownMenuLabel>
                      {group.connections.map((connection) => {
                        const current =
                          connected &&
                          connection.profileId === status?.workspaceConnection.profile?.profileId;
                        return (
                          <DropdownMenuItem
                            key={connection.profileId}
                            className="items-start px-3 py-2.5"
                            disabled={busy !== null || current || !connection.hasDeviceCredential}
                            onSelect={() => void operate(connection, "connect")}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="font-medium">
                                {t(current ? "serverCurrentConnection" : "serverUseConnection")}
                              </div>
                              <div
                                className="mt-1 truncate text-xs text-text-muted"
                                title={connection.profileId}
                              >
                                {connection.workspaceDisplayName} · {connection.profileId.slice(-6)}
                              </div>
                              {!connection.hasDeviceCredential ? (
                                <div className="mt-1 text-xs text-text-muted">
                                  {t("peopleMissingCredential")}
                                </div>
                              ) : null}
                            </div>
                          </DropdownMenuItem>
                        );
                      })}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={busy !== null}
                        variant="destructive"
                        className="px-3 py-2.5"
                        onSelect={() => void operate(server, "forget")}
                      >
                        <div className="min-w-0">
                          <div>{t("serverForgetConnection")}</div>
                          <div
                            className="mt-1 truncate text-xs text-text-muted"
                            title={server.profileId}
                          >
                            {server.workspaceDisplayName} · {server.profileId.slice(-6)}
                          </div>
                        </div>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {checks[server.profileId] ? (
                  <p role="status" className="col-span-5 text-xs text-text-muted">
                    {t("deploymentConnectivity")}: {checks[server.profileId]}
                  </p>
                ) : null}
              </div>
            );
          })}
          {loading ? (
            <p role="status" className="py-8 text-sm text-text-muted">
              {t("peopleWorking")}
            </p>
          ) : null}
          {servers.length === 0 && !loading && !error ? (
            <p className="py-8 text-sm text-text-muted">{t("serverConnectionEmpty")}</p>
          ) : null}
        </div>
      </div>
      <p className="text-xs leading-5 text-text-muted">{t("serverConnectionHint")}</p>
    </div>
  );
}
