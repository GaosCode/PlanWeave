import { useEffect, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { RememberedServerConnectionView } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import type { createTranslator } from "../i18n";
import { collaborationConnectionErrorMessage } from "../collaboration/formatCollaborationError";
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
    if (action === "forget" && !window.confirm(t("serverForgetConfirm"))) return;
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
            endpoint: {
              topology: "public_https",
              serverOrigin: server.serverBaseUrl,
              allowedClientOrigins: [server.serverBaseUrl],
              tlsTrust: "system_ca"
            },
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
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[1fr_1.4fr_.7fr_auto] gap-4 border-b border-border/70 pb-3 text-xs text-text-muted">
            <span>{t("serverSavedConnections")}</span>
            <span>{t("deploymentOrigin")}</span>
            <span>{t("executorsStatusColumn")}</span>
            <span className="w-32" />
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
                className="grid grid-cols-[1fr_1.4fr_.7fr_auto] items-center gap-4 border-b border-border/60 py-5 text-sm"
                key={group.origin}
                data-testid="server-connection-row"
              >
                <span className="font-medium text-text-strong">{server.displayName}</span>
                <span className="truncate text-text-muted" title={server.serverBaseUrl}>
                  {server.serverBaseUrl}
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
                <div className="flex w-32 items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void operate(server, connected ? "check" : "connect")}
                  >
                    {t(connected ? "settingsServerCheckConnectivity" : "settingsServerConnect")}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`${t("managementActions")}: ${server.displayName}`}
                      >
                        <EllipsisIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {group.connections.length > 1
                        ? group.connections.map((connection) => (
                            <DropdownMenuItem
                              key={connection.profileId}
                              disabled={busy !== null}
                              onSelect={() => void operate(connection, "connect")}
                            >
                              {connection.workspaceDisplayName} · {connection.profileId.slice(-6)}
                              {connection.profileId ===
                              status?.workspaceConnection.profile?.profileId
                                ? " ✓"
                                : ""}
                            </DropdownMenuItem>
                          ))
                        : null}
                      <DropdownMenuItem
                        disabled={busy !== null}
                        onSelect={() => void operate(server, "forget")}
                      >
                        {t("settingsServerForget")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {checks[server.profileId] ? (
                  <p role="status" className="col-span-4 text-xs text-text-muted">
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
