import { useEffect, useRef, useState } from "react";
import type {
  DesktopServerExposureMode,
  DesktopServerExposureView
} from "../../shared/deploymentExposure";
import type { RememberedServerConnectionView } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";
import { collaborationConnectionErrorMessage } from "../collaboration/formatCollaborationError";
import type { createTranslator } from "../i18n";

export function sameHttpsOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export type ThisComputerExposureMode = Exclude<DesktopServerExposureMode, "custom_https">;

export function isThisComputerExposureMode(
  value: DesktopServerExposureMode
): value is ThisComputerExposureMode {
  return value !== "custom_https";
}

function originForExistingServer(input: {
  profileOrigin: string;
  advertisedOrigin: string | null;
  exposureMode: DesktopServerExposureMode;
}): string {
  if (input.exposureMode === "custom_https") return input.profileOrigin;
  if (input.advertisedOrigin && sameHttpsOrigin(input.profileOrigin, input.advertisedOrigin)) {
    return "";
  }
  return input.profileOrigin;
}

export function useDeploymentConnectionDraft({
  connectionOnly,
  localOnly,
  onExposureChange,
  t
}: {
  connectionOnly: boolean;
  localOnly: boolean;
  onExposureChange?: (exposure: DesktopServerExposureView) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const [origin, setOrigin] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<DesktopServerExposureMode>(
    connectionOnly ? "custom_https" : "local_only"
  );
  const [thisComputerMode, setThisComputerMode] = useState<ThisComputerExposureMode>("local_only");
  const [exposure, setExposure] = useState<DesktopServerExposureView | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [rememberedServers, setRememberedServers] = useState<RememberedServerConnectionView[]>([]);
  const [selectedRememberedId, setSelectedRememberedId] = useState<string | null>(null);
  const draftRevision = useRef(0);
  const requestGeneration = useRef(0);
  const draftSemantics = useRef(`${connectionOnly}:${localOnly}`);
  const markEdited = () => {
    draftRevision.current += 1;
  };

  useEffect(() => {
    if (!collaborationBridge) return;
    const generation = ++requestGeneration.current;
    const semantics = `${connectionOnly}:${localOnly}`;
    if (draftSemantics.current !== semantics) {
      draftSemantics.current = semantics;
      draftRevision.current = 0;
      setOrigin("");
      setDisplayName("");
      setSelectedRememberedId(null);
      setMode(connectionOnly && !localOnly ? "custom_https" : "local_only");
    }
    const revision = draftRevision.current;
    const isCurrent = () => requestGeneration.current === generation;
    const canInitializeDraft = () => revision === 0 && draftRevision.current === revision;
    if (localOnly) {
      void collaborationBridge
        .getDesktopServerExposure()
        .then((nextExposure) => {
          if (!isCurrent()) return;
          setExposure(nextExposure);
          onExposureChange?.(nextExposure);
          const localMode = isThisComputerExposureMode(nextExposure.mode)
            ? nextExposure.mode
            : "local_only";
          if (canInitializeDraft()) {
            setThisComputerMode(localMode);
            setMode(localMode);
          }
        })
        .catch((cause: unknown) => {
          if (isCurrent()) setConnectError(collaborationConnectionErrorMessage(t, cause));
        });
      return () => {
        if (isCurrent()) requestGeneration.current += 1;
      };
    }
    void Promise.all([
      collaborationBridge.getActiveWorkspaceConnection(),
      collaborationBridge.getDesktopServerExposure(),
      collaborationBridge.listRememberedServerConnections()
    ])
      .then(([connection, nextExposure, remembered]) => {
        if (!isCurrent()) return;
        setExposure(nextExposure);
        onExposureChange?.(nextExposure);
        setRememberedServers(remembered);
        if (!canInitializeDraft()) return;
        if (isThisComputerExposureMode(nextExposure.mode)) {
          setThisComputerMode(nextExposure.mode);
        }
        if (connectionOnly) {
          setMode("custom_https");
          return;
        }
        const remoteProfileId = connection.profile?.profileId;
        const rememberedMatch =
          remoteProfileId === undefined
            ? undefined
            : remembered.find((item) => item.profileId === remoteProfileId);
        const workspaceIsRemote =
          Boolean(rememberedMatch) &&
          connection.status !== "local_only" &&
          connection.profile !== null;
        if (workspaceIsRemote && rememberedMatch) {
          setMode("custom_https");
          setSelectedRememberedId(rememberedMatch.profileId);
          setOrigin(rememberedMatch.serverBaseUrl);
          setDisplayName(rememberedMatch.workspaceDisplayName);
          return;
        }
        setMode(nextExposure.mode);
        setSelectedRememberedId(null);
        if (!connection.profile || !connection.workspaceId) {
          setOrigin("");
          setDisplayName("");
          return;
        }
        const nextOrigin = originForExistingServer({
          profileOrigin: connection.profile.serverBaseUrl,
          advertisedOrigin: nextExposure.advertisedOrigin,
          exposureMode: nextExposure.mode
        });
        setOrigin(nextOrigin);
        setDisplayName(nextOrigin ? connection.profile.displayName : "");
      })
      .catch((cause: unknown) => {
        if (isCurrent()) setConnectError(collaborationConnectionErrorMessage(t, cause));
      });
    return () => {
      if (isCurrent()) requestGeneration.current += 1;
    };
  }, [connectionOnly, localOnly, onExposureChange, t]);

  return {
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
  };
}
