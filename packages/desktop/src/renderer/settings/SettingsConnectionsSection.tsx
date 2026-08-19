import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ServerIcon, WaypointsIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DesktopServerExposureView } from "../../shared/deploymentExposure";
import type { LocalCollaborationServerStatus } from "../../shared/collaboration.js";
import { collaborationBridge } from "../bridge";
import {
  presentOverviewServer,
  type LiveWorkspaceSnapshot,
  type OverviewServerLabel
} from "../collaboration/liveServerStatus";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import {
  type HostAdministrationController,
  useHostAdministrationController
} from "../hooks/useHostAdministrationController";
import type { createTranslator } from "../i18n";
import { SettingsServerSection } from "./SettingsServerSection";

let hostAdministrationContentPromise: Promise<typeof import("./HostAdministrationSection")> | null =
  null;

const loadHostAdministrationContent = () => {
  hostAdministrationContentPromise ??= import("./HostAdministrationSection");
  return hostAdministrationContentPromise;
};

const HostAdministrationContent = lazy(() =>
  loadHostAdministrationContent().then((module) => ({
    default: module.HostAdministrationContent
  }))
);

type ConnectionsTab = "overview" | "devices" | "server";

type SettingsConnectionsSectionProps = {
  diagnosticsEnabled?: boolean;
  initialTab?: ConnectionsTab;
  onTabChange?: () => void;
  t: ReturnType<typeof createTranslator>;
};

function StatusDot({ state }: { state: "ready" | "pending" | "error" | "idle" }) {
  const className =
    state === "ready"
      ? "bg-emerald-500"
      : state === "pending"
        ? "bg-amber-500"
        : state === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/45";
  return <span aria-hidden="true" className={`size-2 rounded-full ${className}`} />;
}

function ConnectionStatus({
  icon: Icon,
  label,
  state,
  status,
  testId
}: {
  icon: typeof ServerIcon;
  label: string;
  state: "ready" | "pending" | "error" | "idle";
  status: string;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-4" data-testid={testId}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-subtle">
        <Icon className="size-4 text-text-muted" />
      </div>
      <span className="min-w-0 flex-1 text-sm font-medium text-text-strong">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot state={state} />
        <span className="max-w-[28rem] truncate text-sm text-text-muted">{status}</span>
      </div>
    </div>
  );
}

function workspaceSnapshot(
  status: ReturnType<typeof useCollaborationStatus>["status"]
): LiveWorkspaceSnapshot | null {
  const connection = status?.workspaceConnection;
  if (!connection) return null;
  return {
    status: connection.status,
    serverBaseUrl: connection.profile?.serverBaseUrl ?? null,
    displayName: connection.workspaceDisplayName ?? null
  };
}

function overviewServerStatusText(
  presentation: ReturnType<typeof presentOverviewServer>,
  t: ReturnType<typeof createTranslator>
): string {
  const labelKey: Record<OverviewServerLabel, Parameters<typeof t>[0]> = {
    remoteConnected: "settingsServerRemoteConnected",
    remoteConnecting: "settingsServerRemoteConnecting",
    remoteError: "settingsServerRemoteError",
    localConnected: "settingsServerLocalConnected",
    preparing: "settingsConnectionsServerPreparing",
    localError: "settingsConnectionsServerError",
    notConnected: "settingsConnectionsServerStopped"
  };
  if (
    (presentation.label === "remoteConnected" ||
      presentation.label === "localConnected" ||
      presentation.label === "remoteError") &&
    presentation.url
  ) {
    return presentation.url;
  }
  return t(labelKey[presentation.label]);
}

function ConnectionsOverview({
  controller,
  t
}: {
  controller: HostAdministrationController;
  t: ReturnType<typeof createTranslator>;
}) {
  const { status } = useCollaborationStatus();
  const [exposure, setExposure] = useState<DesktopServerExposureView | null>(null);
  const [localServer, setLocalServer] = useState<LocalCollaborationServerStatus | null>(null);

  useEffect(() => {
    const api = collaborationBridge;
    if (!api) return;
    let cancelled = false;
    const load = async () => {
      const [nextExposure, nextLocal] = await Promise.all([
        typeof api.getDesktopServerExposure === "function"
          ? api.getDesktopServerExposure().catch(() => null)
          : Promise.resolve(null),
        typeof api.getLocalCollaborationServerStatus === "function"
          ? api.getLocalCollaborationServerStatus().catch(() => null)
          : Promise.resolve(null)
      ]);
      if (cancelled) return;
      setExposure(nextExposure);
      setLocalServer(nextLocal);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const presentation = presentOverviewServer({
    workspace: workspaceSnapshot(status),
    localRunning: localServer?.state === "running",
    localServerBaseUrl: localServer?.profile?.serverBaseUrl ?? null,
    advertisedOrigin: exposure?.advertisedOrigin ?? null,
    localExposureLifecycle: exposure?.lifecycle ?? null
  });
  const serverState = presentation.state;
  const serverStatus = overviewServerStatusText(presentation, t);

  const activeHosts = useMemo(
    () => controller.hosts.filter((host) => !host.revokedAt),
    [controller.hosts]
  );
  const onlineHosts = activeHosts.filter((host) => host.online).length;
  const devicesState =
    controller.error || controller.loadState === "unavailable"
      ? "error"
      : controller.loadState === "loading" || controller.hostsLoading
        ? "pending"
        : onlineHosts > 0
          ? "ready"
          : "idle";
  const devicesStatus =
    controller.error || controller.loadState === "unavailable"
      ? t("settingsConnectionsDevicesUnavailable")
      : controller.loadState === "loading" || controller.hostsLoading
        ? t("settingsConnectionsDevicesLoading")
        : controller.hostsHasMore
          ? t("settingsConnectionsDevicesLoadedPartial")
              .replace("{online}", String(onlineHosts))
              .replace("{loaded}", String(activeHosts.length))
          : t("settingsConnectionsDevicesOnline")
              .replace("{online}", String(onlineHosts))
              .replace("{total}", String(activeHosts.length));

  return (
    <div className="flex max-w-4xl flex-col gap-5" data-testid="settings-connections-overview">
      <h2 className="text-base font-semibold text-text-strong">
        {t("settingsConnectionsOverviewTitle")}
      </h2>

      <div className="flex flex-col gap-2 rounded-xl bg-surface-subtle px-4">
        <ConnectionStatus
          icon={ServerIcon}
          label={t("settingsConnectionsServer")}
          state={serverState}
          status={serverStatus}
          testId="settings-connections-server-state"
        />
        <ConnectionStatus
          icon={WaypointsIcon}
          label={t("settingsConnectionsDevices")}
          state={devicesState}
          status={devicesStatus}
          testId="settings-connections-devices-state"
        />
      </div>
    </div>
  );
}

export function SettingsConnectionsSection({
  diagnosticsEnabled = false,
  initialTab = "overview",
  onTabChange,
  t
}: SettingsConnectionsSectionProps) {
  const [tab, setTab] = useState<ConnectionsTab>(initialTab);
  const previousTabRef = useRef(tab);
  const hostController = useHostAdministrationController();

  useEffect(() => {
    void loadHostAdministrationContent();
  }, []);

  useLayoutEffect(() => {
    if (previousTabRef.current === tab) return;
    previousTabRef.current = tab;
    onTabChange?.();
  }, [onTabChange, tab]);

  const selectTab = (value: string) => {
    if (value === "overview" || value === "devices" || value === "server") {
      if (value === tab) return;
      setTab(value);
    }
  };

  return (
    <section className="flex flex-col gap-6" data-testid="settings-connections-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text-strong">
          {t("settingsConnections")}
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
          {t("settingsConnectionsHint")}
        </p>
      </div>

      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList variant="line" aria-label={t("settingsConnections")}>
          <TabsTrigger value="overview" data-testid="settings-connections-tab-overview">
            {t("settingsConnectionsOverview")}
          </TabsTrigger>
          <TabsTrigger value="devices" data-testid="settings-connections-tab-devices">
            {t("settingsConnectionsDevices")}
          </TabsTrigger>
          <TabsTrigger value="server" data-testid="settings-connections-tab-server">
            {t("settingsConnectionsAdvanced")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <ConnectionsOverview controller={hostController} t={t} />
        </TabsContent>
        <TabsContent value="devices" className="pt-0">
          <Suspense
            fallback={
              <div className="text-sm text-text-muted" data-testid="host-admin-loading">
                {t("hostAdminLoading")}
              </div>
            }
          >
            <HostAdministrationContent
              controller={hostController}
              diagnosticsEnabled={diagnosticsEnabled}
              showDeploymentConnection={false}
              showHeader={false}
              t={t}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="server" className="pt-4">
          <SettingsServerSection showHeader={false} t={t} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
