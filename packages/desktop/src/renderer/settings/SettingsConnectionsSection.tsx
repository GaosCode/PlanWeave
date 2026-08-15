import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ServerIcon, WaypointsIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DesktopServerExposureView } from "../../shared/deploymentExposure";
import { collaborationBridge } from "../bridge";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
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

type ConnectionsTab = "overview" | "devices" | "advanced";

type SettingsConnectionsSectionProps = {
  diagnosticsEnabled?: boolean;
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

function ConnectionsOverview({
  controller,
  t
}: {
  controller: HostAdministrationController;
  t: ReturnType<typeof createTranslator>;
}) {
  const { status } = useCollaborationStatus();
  const [exposure, setExposure] = useState<DesktopServerExposureView | null>(null);

  useEffect(() => {
    if (
      !collaborationBridge ||
      typeof collaborationBridge.getDesktopServerExposure !== "function"
    ) {
      return;
    }
    let cancelled = false;
    void collaborationBridge.getDesktopServerExposure().then(
      (next) => {
        if (!cancelled) setExposure(next);
      },
      () => {
        if (!cancelled) setExposure(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const activeServerProfile = status?.activeProfileId
    ? (status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null)
    : null;
  const remoteServerConnected = isCollaborationSessionConnected(status) && activeServerProfile;
  const serverState =
    exposure?.lifecycle === "ready" || remoteServerConnected
      ? "ready"
      : exposure?.lifecycle === "preparing"
        ? "pending"
        : exposure?.lifecycle === "error"
          ? "error"
          : "idle";
  const serverStatus = remoteServerConnected
    ? activeServerProfile.serverBaseUrl
    : exposure?.lifecycle === "ready"
      ? (exposure.advertisedOrigin ?? t("settingsConnectionsServerReady"))
      : exposure?.lifecycle === "preparing"
        ? t("settingsConnectionsServerPreparing")
        : exposure?.lifecycle === "error"
          ? t("settingsConnectionsServerError")
          : t("settingsConnectionsServerStopped");

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
  onTabChange,
  t
}: SettingsConnectionsSectionProps) {
  const [tab, setTab] = useState<ConnectionsTab>("overview");
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
    if (value === "overview" || value === "devices" || value === "advanced") {
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
          <TabsTrigger value="advanced" data-testid="settings-connections-tab-advanced">
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
        <TabsContent value="advanced" className="pt-4">
          <SettingsServerSection showHeader={false} t={t} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
