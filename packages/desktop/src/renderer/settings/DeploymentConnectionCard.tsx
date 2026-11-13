import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIcon, ChevronDownIcon, ChevronUpIcon, Link2Icon } from "lucide-react";
import { deploymentTargetDraftSchema } from "@planweave-ai/collaboration-protocol/deployment";
import type {
  ConnectivityValidationView,
  DeploymentGuidanceView,
  DeploymentTargetDraft,
  DeploymentTopology
} from "@planweave-ai/collaboration-protocol/deployment";
import type {
  DesktopServerExposureErrorCode,
  DesktopServerExposureView
} from "../../shared/deploymentExposure";
import { deploymentArchiveFailureCodes as archiveFailureCodes } from "../../shared/deploymentArchiveFailureCodes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { collaborationBridge } from "../bridge";
import {
  collaborationErrorCode,
  collaborationConnectionErrorMessage
} from "../collaboration/formatCollaborationError";
import type { RememberedServerConnectionView } from "../../shared/collaboration";
import type { createTranslator } from "../i18n";

import {
  useDeploymentConnectionDraft,
  isThisComputerExposureMode,
  sameHttpsOrigin,
  type ThisComputerExposureMode
} from "./useDeploymentConnectionDraft";

type ExistingServerTools = "visible" | "collapsed" | "hidden";
type TargetIdentity = { key: string | null; generation: number };
type CheckState<T> =
  | { generation: number; request: number; status: "loading" }
  | { generation: number; request: number; status: "ready"; value: T }
  | { generation: number; request: number; status: "error" };
type OperationState<T extends string> = {
  generation: number;
  request: number;
  status: "loading" | "error" | T;
};

function currentIdentity(
  identity: { current: TargetIdentity },
  key: string | null
): TargetIdentity {
  if (identity.current.key !== key) {
    identity.current = { key, generation: identity.current.generation + 1 };
  }
  return identity.current;
}

const settingsGroupClass = "gap-0";
const settingsRowClass =
  "max-sm:flex-col max-sm:items-stretch items-center justify-between gap-3 border-b border-border/80 px-0 py-3.5 last:border-b-0 sm:gap-6";
const settingsControlClass = "w-full min-w-0 sm:w-80";

function SettingsFieldSelect({
  id,
  label,
  value,
  onValueChange,
  testId,
  items,
  description
}: {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  testId: string;
  items: ReadonlyArray<{ value: string; label: string }>;
  description?: string;
}) {
  return (
    <Field orientation="horizontal" className={settingsRowClass}>
      <FieldContent>
        <FieldLabel htmlFor={id} className="text-sm font-semibold">
          {label}
        </FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          id={id}
          aria-label={label}
          className={settingsControlClass}
          data-testid={testId}
          data-value={value}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

type Props = {
  t: ReturnType<typeof createTranslator>;
  /** card: standalone Card; section/plain: People-style stack; embedded: Settings card body. */
  presentation?: "card" | "section" | "plain" | "embedded";
  showHeading?: boolean;
  onExposureChange?: (exposure: DesktopServerExposureView) => void;
  onExistingServerChange?: (existing: boolean) => void;
  /** Deploy/export fields for an existing Server. Settings hides them from the connect path. */
  connectionOnly?: boolean;
  localOnly?: boolean;
  existingServerTools?: ExistingServerTools;
  onConnected?: () => void | Promise<void>;
  showAdvertisedOrigin?: boolean;
  /** Alternate join path rendered below origin actions, not in the action row. */
  connectAlternative?: ReactNode;
  onNeedConnectionDetails?: () => void;
};

function normalizedOrigin(value: string): string {
  return `${new URL(value.trim()).origin}/`;
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function rememberedServerLabel(item: RememberedServerConnectionView): string {
  return `${item.workspaceDisplayName} (${hostnameOf(item.serverBaseUrl)})`;
}

function connectivityLabel(
  view: ConnectivityValidationView,
  t: ReturnType<typeof createTranslator>
): string {
  if (view.status === "reachable") return t("deploymentConnectivityReachable");
  if (view.status === "invalid_tls") return t("deploymentConnectivityTls");
  if (view.status === "invalid_origin") return t("deploymentConnectivityOrigin");
  if (view.status === "invalid_configuration") return t("deploymentConnectivityConfiguration");
  return t("deploymentConnectivityUnreachable");
}

function exposureErrorLabel(
  code: DesktopServerExposureErrorCode,
  t: ReturnType<typeof createTranslator>
): string {
  if (code === "PRIVATE_HTTPS_PROVIDER_NOT_INSTALLED") {
    return t("deploymentPrivateHttpsProviderNotInstalled");
  }
  if (code === "PRIVATE_HTTPS_PROVIDER_AUTH_REQUIRED") {
    return t("deploymentPrivateHttpsProviderAuthRequired");
  }
  if (
    code === "PRIVATE_HTTPS_DNS_UNAVAILABLE" ||
    code === "PRIVATE_HTTPS_CERTIFICATE_UNAVAILABLE"
  ) {
    return t("deploymentPrivateHttpsUnavailable");
  }
  if (code === "PRIVATE_HTTPS_ROUTE_CONFLICT") {
    return t("deploymentPrivateHttpsRouteConflict");
  }
  if (code.startsWith("PRIVATE_HTTPS_")) {
    return t("deploymentPrivateHttpsProviderUnavailable");
  }
  return t("deploymentServerStartFailed");
}

function exportErrorLabel(
  code: string | null | undefined,
  t: ReturnType<typeof createTranslator>
): string {
  switch (code) {
    case archiveFailureCodes.destinationNotFile:
      return t("deploymentExportDestinationNotFile");
    case archiveFailureCodes.permissionsUnavailable:
      return t("deploymentExportPermissionsUnavailable");
    case archiveFailureCodes.cleanupFailed:
      return t("deploymentExportCleanupFailed");
    case archiveFailureCodes.committedCleanupFailed:
      return t("deploymentExportCommittedCleanupFailed");
    default:
      return t("deploymentExportFailed");
  }
}

export function DeploymentConnectionCard({
  t,
  presentation = "card",
  showHeading = presentation !== "embedded",
  onExposureChange,
  onExistingServerChange,
  existingServerTools = "visible",
  connectionOnly = false,
  localOnly = false,
  onConnected,
  showAdvertisedOrigin = true,
  connectAlternative,
  onNeedConnectionDetails
}: Props) {
  const {
    origin,
    setOrigin,
    displayName,
    setDisplayName,
    mode,
    setMode,
    thisComputerMode,
    setThisComputerMode,
    exposure,
    setExposure,
    connectError,
    setConnectError,
    rememberedServers,
    setRememberedServers,
    selectedRememberedId,
    setSelectedRememberedId,
    markEdited
  } = useDeploymentConnectionDraft({ connectionOnly, localOnly, onExposureChange, t });
  const [customTopology, setCustomTopology] =
    useState<Extract<DeploymentTopology, "loopback_https" | "private_https" | "public_https">>(
      "public_https"
    );
  const [guidanceState, setGuidanceState] = useState<CheckState<DeploymentGuidanceView> | null>(
    null
  );
  const [connectivityState, setConnectivityState] =
    useState<CheckState<ConnectivityValidationView> | null>(null);
  const [copyState, setCopyState] = useState<OperationState<"copied"> | null>(null);
  const [exportState, setExportState] = useState<
    | (OperationState<"exported" | "needs_project" | "invalid_project" | "cancelled"> & {
        errorCode?: string | null;
      })
    | null
  >(null);
  const [busy, setBusy] = useState<"activation" | "connect" | null>(null);
  const [activationNotice, setActivationNotice] = useState<"invalid" | null>(null);
  const [deployToolsOpen, setDeployToolsOpen] = useState(false);
  const guidanceIdentityRef = useRef<TargetIdentity>({ key: null, generation: 0 });
  const connectivityIdentityRef = useRef<TargetIdentity>({ key: null, generation: 0 });
  const requestSequence = useRef({ guidance: 0, validation: 0, copy: 0, export: 0 });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const existingServer = mode === "custom_https";
  const showExistingServerDeploy = existingServer && existingServerTools !== "hidden";
  useEffect(() => {
    onExistingServerChange?.(existingServer);
  }, [existingServer, onExistingServerChange]);

  const target = useMemo(() => {
    try {
      const trimmedDisplayName = displayName.trim();
      if (mode !== "custom_https" || !trimmedDisplayName) return null;
      const serverOrigin = normalizedOrigin(origin);
      const draft = {
        schemaVersion: "deployment-target-draft/v1",
        displayName: trimmedDisplayName,
        endpoint: {
          topology: customTopology,
          serverOrigin,
          allowedClientOrigins: [serverOrigin],
          tlsTrust: "system_ca"
        },
        capabilities: ["deployment_guidance", "connectivity_validation"]
      } satisfies DeploymentTargetDraft;
      return deploymentTargetDraftSchema.safeParse(draft).success ? draft : null;
    } catch {
      return null;
    }
  }, [customTopology, displayName, mode, origin]);

  const originTarget = useMemo(() => {
    try {
      if (mode !== "custom_https") return null;
      const serverOrigin = normalizedOrigin(origin);
      const hostname = new URL(serverOrigin).hostname;
      if (!hostname) return null;
      const draft = {
        schemaVersion: "deployment-target-draft/v1",
        displayName: displayName.trim() || hostname,
        endpoint: {
          topology: customTopology,
          serverOrigin,
          allowedClientOrigins: [serverOrigin],
          tlsTrust: "system_ca"
        },
        capabilities: ["deployment_guidance", "connectivity_validation"]
      } satisfies DeploymentTargetDraft;
      return deploymentTargetDraftSchema.safeParse(draft).success ? draft : null;
    } catch {
      return null;
    }
  }, [customTopology, displayName, mode, origin]);

  const guidanceKey = target === null ? null : JSON.stringify(target);
  const connectivityKey = originTarget === null ? null : JSON.stringify(originTarget.endpoint);
  const guidanceIdentity = currentIdentity(guidanceIdentityRef, guidanceKey);
  const connectivityIdentity = currentIdentity(connectivityIdentityRef, connectivityKey);
  const visibleGuidanceState =
    guidanceState?.generation === guidanceIdentity.generation ? guidanceState : null;
  const visibleConnectivityState =
    connectivityState?.generation === connectivityIdentity.generation ? connectivityState : null;
  const visibleCopyState = copyState?.generation === guidanceIdentity.generation ? copyState : null;
  const visibleExportState =
    exportState?.generation === guidanceIdentity.generation ? exportState : null;
  const guidance = visibleGuidanceState?.status === "ready" ? visibleGuidanceState.value : null;
  const connectivity =
    visibleConnectivityState?.status === "ready" ? visibleConnectivityState.value : null;
  const guidanceLoading = visibleGuidanceState?.status === "loading";
  const validationLoading = visibleConnectivityState?.status === "loading";
  const copyLoading = visibleCopyState?.status === "loading";
  const exportLoading = visibleExportState?.status === "loading";
  const actionError =
    visibleGuidanceState?.status === "error" ||
    visibleConnectivityState?.status === "error" ||
    visibleCopyState?.status === "error";

  const activate = async () => {
    if (!collaborationBridge || mode === "custom_https") return;
    setBusy("activation");
    try {
      const next = await collaborationBridge.setDesktopServerExposureMode({ mode });
      setExposure(next);
      onExposureChange?.(next);
      setActivationNotice(next.lifecycle === "error" ? "invalid" : null);
      await onConnected?.();
    } catch {
      setActivationNotice("invalid");
    } finally {
      setBusy(null);
    }
  };

  const requestGuidance = async () => {
    if (!collaborationBridge || !target) return;
    const input = { action: "request_deployment_guidance" as const, target };
    const { generation } = guidanceIdentity;
    const request = ++requestSequence.current.guidance;
    const isCurrent = () =>
      mounted.current &&
      guidanceIdentityRef.current.generation === generation &&
      requestSequence.current.guidance === request;
    setGuidanceState({ generation, request, status: "loading" });
    try {
      const value = await collaborationBridge.getDeploymentGuidance(input);
      if (isCurrent()) {
        setGuidanceState(
          JSON.stringify(value.target) === guidanceKey
            ? { generation, request, status: "ready", value }
            : { generation, request, status: "error" }
        );
      }
    } catch {
      if (isCurrent()) setGuidanceState({ generation, request, status: "error" });
    }
  };

  const validate = async () => {
    if (!collaborationBridge || !originTarget) return;
    const input = { action: "validate_connectivity" as const, target: originTarget };
    const { generation } = connectivityIdentity;
    const request = ++requestSequence.current.validation;
    const isCurrent = () =>
      mounted.current &&
      connectivityIdentityRef.current.generation === generation &&
      requestSequence.current.validation === request;
    setConnectivityState({ generation, request, status: "loading" });
    try {
      const value = await collaborationBridge.validateDeploymentConnectivity(input);
      if (isCurrent()) setConnectivityState({ generation, request, status: "ready", value });
    } catch {
      if (isCurrent()) setConnectivityState({ generation, request, status: "error" });
    }
  };

  const copy = async () => {
    if (!collaborationBridge || !guidance || !target) return;
    const input = { action: "copy_supported_compose_handoff" as const, target: guidance.target };
    const { generation } = guidanceIdentity;
    const request = ++requestSequence.current.copy;
    const isCurrent = () =>
      mounted.current &&
      guidanceIdentityRef.current.generation === generation &&
      requestSequence.current.copy === request;
    setCopyState({ generation, request, status: "loading" });
    try {
      await collaborationBridge.copyDeploymentComposeHandoff(input);
      if (isCurrent()) setCopyState({ generation, request, status: "copied" });
    } catch {
      if (isCurrent()) setCopyState({ generation, request, status: "error" });
    }
  };

  const exportBundle = async () => {
    if (!collaborationBridge || !guidance || !target) return;
    const input = { action: "export_supported_compose_bundle" as const, target: guidance.target };
    const { generation } = guidanceIdentity;
    const request = ++requestSequence.current.export;
    const isCurrent = () =>
      mounted.current &&
      guidanceIdentityRef.current.generation === generation &&
      requestSequence.current.export === request;
    setExportState({ generation, request, status: "loading" });
    try {
      const result = await collaborationBridge.exportDeploymentComposeBundle(input);
      if (isCurrent()) {
        setExportState({ generation, request, status: result.state });
      }
    } catch (error) {
      if (isCurrent()) {
        setExportState({
          generation,
          request,
          status: "error",
          errorCode: collaborationErrorCode(error)
        });
      }
    }
  };

  const connectByOrigin = async () => {
    markEdited();
    if (!collaborationBridge) return;
    setConnectError(null);
    let serverBaseUrl: string;
    try {
      serverBaseUrl = normalizedOrigin(origin);
    } catch {
      setConnectError(t("peopleServerUrlInvalid"));
      return;
    }
    setBusy("connect");
    try {
      await collaborationBridge.connectExistingServerByOrigin({
        serverBaseUrl
      });
      const remembered = await collaborationBridge.listRememberedServerConnections();
      setRememberedServers(remembered);
      const match = remembered.find((item) => sameHttpsOrigin(item.serverBaseUrl, serverBaseUrl));
      setSelectedRememberedId(match?.profileId ?? null);
      await onConnected?.();
    } catch (error) {
      const code = collaborationErrorCode(error);
      if (code === "existing_server_admission_required") {
        setConnectError(t("settingsServerAdmissionRequired"));
        onNeedConnectionDetails?.();
      } else {
        setConnectError(
          code === "existing_server_origin_invalid"
            ? t("peopleServerUrlInvalid")
            : collaborationConnectionErrorMessage(t, error)
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const connectRemembered = async (profileId: string) => {
    if (!collaborationBridge) return;
    setConnectError(null);
    setBusy("connect");
    try {
      await collaborationBridge.selectWorkspaceConnection({ profileId });
      const remembered = await collaborationBridge.listRememberedServerConnections();
      setRememberedServers(remembered);
      await onConnected?.();
    } catch (error) {
      const code = collaborationErrorCode(error);
      if (
        code === "collaboration_credential_missing" ||
        code === "existing_server_admission_required"
      ) {
        setConnectError(t("settingsServerAdmissionRequired"));
        onNeedConnectionDetails?.();
      } else {
        setConnectError(collaborationConnectionErrorMessage(t, error));
      }
    } finally {
      setBusy(null);
    }
  };

  const forgetRemembered = async (profileId: string) => {
    markEdited();
    if (!collaborationBridge) return;
    setConnectError(null);
    setBusy("connect");
    try {
      await collaborationBridge.forgetRememberedServerConnection({ profileId });
      const remembered = await collaborationBridge.listRememberedServerConnections();
      setRememberedServers(remembered);
      if (selectedRememberedId === profileId) {
        setSelectedRememberedId(null);
        setMode(thisComputerMode);
        setOrigin("");
        setDisplayName("");
      }
      await onConnected?.();
    } catch (error) {
      setConnectError(collaborationConnectionErrorMessage(t, error));
    } finally {
      setBusy(null);
    }
  };

  const originField = (
    <Field orientation="horizontal" className={settingsRowClass}>
      <FieldContent>
        <FieldLabel htmlFor="deployment-origin" className="text-sm font-semibold">
          {t("deploymentOrigin")}
        </FieldLabel>
        {existingServerTools !== "visible" ? (
          <FieldDescription data-testid="deployment-existing-connect-hint">
            {t("settingsServerExistingHint")}
          </FieldDescription>
        ) : null}
      </FieldContent>
      <Input
        id="deployment-origin"
        className={settingsControlClass}
        data-testid="deployment-origin"
        value={origin}
        onChange={(event) => {
          markEdited();
          setOrigin(event.target.value);
        }}
        autoComplete="off"
        spellCheck={false}
        placeholder="https://"
      />
    </Field>
  );

  const existingServerDeployFields = (
    <FieldGroup className={settingsGroupClass}>
      <Field orientation="horizontal" className={settingsRowClass}>
        <FieldContent>
          <FieldLabel htmlFor="deployment-display-name" className="text-sm font-semibold">
            {t("deploymentDisplayName")}
          </FieldLabel>
        </FieldContent>
        <Input
          id="deployment-display-name"
          className={settingsControlClass}
          data-testid="deployment-display-name"
          value={displayName}
          onChange={(event) => {
            markEdited();
            setDisplayName(event.target.value);
          }}
        />
      </Field>
      {existingServerTools === "visible" ? originField : null}
      <SettingsFieldSelect
        id="deployment-custom-topology"
        label={t("deploymentCustomTopology")}
        value={customTopology}
        testId="deployment-custom-topology"
        onValueChange={(next) => {
          markEdited();
          setCustomTopology(next as typeof customTopology);
        }}
        items={[
          { value: "loopback_https", label: t("deploymentLoopbackHttps") },
          { value: "private_https", label: t("deploymentPrivateHttpsTopology") },
          { value: "public_https", label: t("deploymentPublicHttps") }
        ]}
      />
      {existingServerTools === "visible" ? (
        <div className="grid gap-1 border-b border-border/80 px-0 py-3.5 text-xs leading-5 text-text-muted">
          <p data-testid="deployment-existing-server-note">{t("deploymentExistingServerNote")}</p>
          <p>{t("deploymentSystemTrustNote")}</p>
          <p>{t("deploymentTopologySource")}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 px-0 py-3.5">
        <Button
          type="button"
          disabled={!target || busy !== null || guidanceLoading}
          onClick={() => void requestGuidance()}
        >
          {t("deploymentReview")}
        </Button>
        {existingServerTools === "visible" ? (
          <Button
            type="button"
            variant="outline"
            disabled={!originTarget || busy !== null || validationLoading}
            onClick={() => void validate()}
          >
            {t("deploymentValidate")}
          </Button>
        ) : null}
      </div>
    </FieldGroup>
  );

  const existingServerDeploy = showExistingServerDeploy ? (
    existingServerTools === "collapsed" ? (
      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit px-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-text-strong"
          aria-expanded={deployToolsOpen}
          data-testid="deployment-export-package"
          onClick={() => setDeployToolsOpen((open) => !open)}
        >
          {deployToolsOpen ? (
            <ChevronUpIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          )}
          {t("settingsServerDeployTools")}
        </Button>
        {deployToolsOpen ? existingServerDeployFields : null}
      </div>
    ) : (
      existingServerDeployFields
    )
  ) : null;

  const content = (
    <div className="grid max-w-3xl gap-4">
      <FieldGroup className={settingsGroupClass}>
        {!connectionOnly && !localOnly ? (
          <SettingsFieldSelect
            id="deployment-kind"
            label={t("deploymentKind")}
            value={
              mode === "custom_https"
                ? (selectedRememberedId ?? "existing_server")
                : "this_computer"
            }
            testId="deployment-kind"
            onValueChange={(nextKind) => {
              markEdited();
              if (nextKind === "existing_server") {
                if (isThisComputerExposureMode(mode)) setThisComputerMode(mode);
                setMode("custom_https");
                setSelectedRememberedId(null);
                if (
                  exposure?.advertisedOrigin &&
                  origin &&
                  sameHttpsOrigin(origin, exposure.advertisedOrigin)
                ) {
                  setOrigin("");
                  setDisplayName("");
                }
                return;
              }
              if (nextKind === "this_computer") {
                setSelectedRememberedId(null);
                if (mode === "custom_https") setMode(thisComputerMode);
                return;
              }
              const remembered = rememberedServers.find((item) => item.profileId === nextKind);
              if (!remembered) return;
              if (isThisComputerExposureMode(mode)) setThisComputerMode(mode);
              setMode("custom_https");
              setSelectedRememberedId(remembered.profileId);
              setOrigin(remembered.serverBaseUrl);
              setDisplayName(remembered.workspaceDisplayName);
              void connectRemembered(remembered.profileId);
            }}
            items={[
              { value: "this_computer", label: t("deploymentThisComputer") },
              ...rememberedServers.map((item) => ({
                value: item.profileId,
                label: rememberedServerLabel(item)
              })),
              {
                value: "existing_server",
                label:
                  rememberedServers.length > 0
                    ? t("deploymentConnectAnotherServer")
                    : t("deploymentExistingServer")
              }
            ]}
          />
        ) : null}
        {mode !== "custom_https" ? (
          <SettingsFieldSelect
            id="deployment-topology"
            label={t("deploymentTopology")}
            value={mode}
            testId="deployment-topology"
            onValueChange={(nextMode) => {
              markEdited();
              const typed = nextMode as ThisComputerExposureMode;
              setThisComputerMode(typed);
              setMode(typed);
            }}
            items={[
              { value: "local_only", label: t("deploymentLoopback") },
              { value: "private_https", label: t("deploymentPrivateHttps") },
              { value: "lan_http", label: t("deploymentLanAdvanced") }
            ]}
          />
        ) : null}
        {existingServer && existingServerTools !== "visible" ? (
          <div data-testid="deployment-existing-origin-connect">
            {originField}
            <div
              className="flex flex-wrap items-center gap-2 px-0 py-3.5"
              data-testid="deployment-existing-tools"
            >
              <Button
                type="button"
                className="px-3"
                data-testid="deployment-origin-connect"
                disabled={busy !== null || origin.trim().length === 0}
                onClick={() => void connectByOrigin()}
              >
                <Link2Icon aria-hidden="true" data-icon="inline-start" />
                {busy === "connect"
                  ? t("settingsServerReconnectSessionBusy")
                  : t("settingsServerConnect")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="px-3"
                data-testid="deployment-check-connectivity"
                disabled={busy !== null || validationLoading || !originTarget}
                onClick={() => void validate()}
              >
                <ActivityIcon aria-hidden="true" data-icon="inline-start" />
                {t("settingsServerCheckConnectivity")}
              </Button>
              {selectedRememberedId ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="px-3"
                  data-testid="deployment-forget-server"
                  disabled={busy !== null}
                  onClick={() => void forgetRemembered(selectedRememberedId)}
                >
                  {t("settingsServerForget")}
                </Button>
              ) : null}
            </div>
            {connectError ? (
              <p
                className="border-t border-border/80 px-0 py-3 text-xs text-destructive"
                data-testid="deployment-origin-connect-error"
                role="alert"
              >
                {connectError}
              </p>
            ) : null}
          </div>
        ) : null}
        {mode !== "custom_https" && exposure !== null && exposure.mode !== mode ? (
          <div className="px-0 py-3.5">
            <Button
              type="button"
              className="w-fit px-3"
              disabled={busy !== null || exposure.canActivate === false}
              onClick={() => void activate()}
            >
              <Link2Icon aria-hidden="true" data-icon="inline-start" />
              {t("deploymentActivate")}
            </Button>
          </div>
        ) : null}
      </FieldGroup>
      {connectAlternative}
      {existingServerDeploy}
      {showAdvertisedOrigin && !existingServer && exposure?.advertisedOrigin ? (
        <p className="text-xs" data-testid="deployment-advertised-origin">
          {t("deploymentAdvertisedOrigin")}: {exposure.advertisedOrigin}
        </p>
      ) : null}
      {!existingServer && exposure?.provider && mode !== "private_https" ? (
        <p className="text-xs text-text-muted" data-testid="deployment-exposure-provider">
          {t("deploymentPrivateHttpsProvider")}: {exposure.provider.displayName}
        </p>
      ) : null}
      {exposure?.errorCode ? (
        <p
          className="text-xs text-destructive"
          data-testid="deployment-exposure-error"
          data-error-code={exposure.errorCode}
        >
          {exposureErrorLabel(exposure.errorCode, t)}
        </p>
      ) : null}
      {guidance ? (
        <div className="grid gap-1 text-xs" data-testid="deployment-guidance">
          <div>{t("deploymentDurableState")}</div>
          <div>{t("deploymentHealthcheck")}</div>
          {guidance.handoff.state === "supported" ? (
            <>
              <code className="break-all">{guidance.handoff.preview}</code>
              <p>
                {t("deploymentMount")}: {guidance.handoff.projectsMountTarget}
              </p>
              <p>
                {t("deploymentTrustedPath")}: {guidance.handoff.trustedProjectRootPattern}
              </p>
              <Button
                type="button"
                className="w-fit"
                disabled={busy !== null || copyLoading}
                onClick={() => void copy()}
              >
                {t("deploymentCopy")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                disabled={busy !== null || exportLoading}
                onClick={() => void exportBundle()}
              >
                {t("deploymentExport")}
              </Button>
              <p className="text-text-muted">{t("deploymentExportInstructions")}</p>
            </>
          ) : (
            <p>{t("deploymentLoopbackNote")}</p>
          )}
        </div>
      ) : null}
      {connectivity ? (
        <p className="text-xs" data-testid="deployment-connectivity">
          {t("deploymentConnectivity")}: {connectivityLabel(connectivity, t)}
        </p>
      ) : null}
      {visibleCopyState?.status === "copied" ? (
        <p className="text-xs" role="status">
          {t("deploymentCopied")}
        </p>
      ) : null}
      {visibleExportState?.status === "exported" ? (
        <p className="text-xs">{t("deploymentExported")}</p>
      ) : null}
      {visibleExportState?.status === "needs_project" ? (
        <p className="text-xs text-destructive" role="alert">
          {t("deploymentExportNeedsProject")}
        </p>
      ) : null}
      {visibleExportState?.status === "invalid_project" ? (
        <p className="text-xs text-destructive" role="alert">
          {t("deploymentExportInvalidProject")}
        </p>
      ) : null}
      {visibleExportState?.status === "error" ? (
        <p className="text-xs text-destructive" role="alert">
          {exportErrorLabel(visibleExportState.errorCode, t)}
        </p>
      ) : null}
      {actionError || (mode !== "custom_https" && activationNotice === "invalid") ? (
        <p className="text-xs text-destructive" role="alert">
          {t("deploymentInvalid")}
        </p>
      ) : null}
    </div>
  );

  if (presentation === "embedded") {
    return (
      <section className="flex flex-col gap-3" data-testid="deployment-connection">
        {content}
      </section>
    );
  }

  if (presentation === "section") {
    return (
      <section className="mt-7 border-t border-border/70 py-8" data-testid="deployment-connection">
        <div className="mb-5 max-w-3xl">
          <h2 className="text-base font-semibold text-text-strong">{t("deploymentTitle")}</h2>
          <p className="mt-1 text-sm leading-6 text-text-muted">{t("deploymentDescription")}</p>
        </div>
        {content}
      </section>
    );
  }

  if (presentation === "plain") {
    return (
      <section
        className={existingServer && existingServerTools !== "visible" ? undefined : "pb-8"}
        data-testid="deployment-connection"
      >
        {showHeading ? (
          <div className="mb-5 max-w-3xl">
            <h2 className="text-base font-semibold text-text-strong">{t("deploymentTitle")}</h2>
            <p className="mt-1 text-sm leading-6 text-text-muted">{t("deploymentDescription")}</p>
          </div>
        ) : null}
        {content}
      </section>
    );
  }

  return (
    <Card data-testid="deployment-connection">
      <CardHeader>
        <CardTitle>{t("deploymentTitle")}</CardTitle>
        <CardDescription>{t("deploymentDescription")}</CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
