import { useCallback, useEffect, useMemo, useState } from "react";
import type { OperatorControlStatus } from "../../shared/operatorControl";
import type { CanvasLocator } from "../../shared/canvasLocator";
import type { CollaborationStatus } from "../../shared/collaboration";
import type { CollaborationMemberSummary } from "../../shared/collaborationReadModels";
import { operatorControlBridge } from "../bridge";
import { resolveDesktopHumanPrincipalId } from "../collaboration/desktopHumanPrincipal";
import { resolveCurrentMembership } from "../collaboration/peopleViewModels";

export type OwnerControlPlaneAvailability = {
  /** Active operator profile with a stored credential — fleet catalog may load. */
  fleetCatalogEnabled: boolean;
  operatorProfileId: string | null;
  humanPrincipalId: string | null;
  /** Stable code when fleet catalog cannot load due to missing operator setup. */
  fleetCatalogBlockedCode: string | null;
  status: OperatorControlStatus | null;
  refresh: () => Promise<void>;
};

export type CanvasFleetCatalogAuthority = Pick<
  OwnerControlPlaneAvailability,
  "fleetCatalogEnabled" | "operatorProfileId" | "fleetCatalogBlockedCode"
>;

export type CanvasAgentAuthority = CanvasFleetCatalogAuthority & {
  humanPrincipalId: string | null;
};

function originOf(serverBaseUrl: string): string | null {
  try {
    return new URL(serverBaseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Ordinary Canvases use the active Human fleet. Workspace Canvases may use an
 * Operator profile only when it targets the same Server as their authority
 * profile; otherwise their collaboration session remains the catalog path.
 */
export function deriveCanvasFleetCatalogAuthority(input: {
  status: OperatorControlStatus | null;
  workspaceServerBaseUrl?: string | null;
  preferredProfileId?: string;
  bridgeAvailable?: boolean;
}): CanvasFleetCatalogAuthority {
  if (input.workspaceServerBaseUrl === undefined) {
    return {
      fleetCatalogEnabled:
        deriveFleetCatalogBlockedCode(input.status, {
          bridgeAvailable: input.bridgeAvailable
        }) === null,
      operatorProfileId: input.status?.activeProfileId ?? null,
      fleetCatalogBlockedCode: deriveFleetCatalogBlockedCode(input.status, {
        bridgeAvailable: input.bridgeAvailable
      })
    };
  }
  const workspaceOrigin = input.workspaceServerBaseUrl
    ? originOf(input.workspaceServerBaseUrl)
    : null;
  if (!workspaceOrigin || input.bridgeAvailable === false) {
    return {
      fleetCatalogEnabled: false,
      operatorProfileId: null,
      fleetCatalogBlockedCode: null
    };
  }
  const candidates =
    input.status?.profiles.filter(
      (profile) =>
        profile.hasOperatorCredential && originOf(profile.serverBaseUrl) === workspaceOrigin
    ) ?? [];
  const preferred = candidates.find((profile) => profile.profileId === input.preferredProfileId);
  const active = candidates.find((profile) => profile.profileId === input.status?.activeProfileId);
  const selected = preferred ?? active ?? (candidates.length === 1 ? candidates[0] : undefined);
  return {
    fleetCatalogEnabled: selected !== undefined,
    operatorProfileId: selected?.profileId ?? null,
    fleetCatalogBlockedCode: null
  };
}

export function deriveCanvasAgentAuthority(input: {
  canvasLocator: CanvasLocator | null;
  collaborationStatus: CollaborationStatus | null;
  collaborationMembers: readonly CollaborationMemberSummary[];
  ownerControlPlane: OwnerControlPlaneAvailability;
}): CanvasAgentAuthority {
  const locator = input.canvasLocator;
  if (locator?.kind !== "workspace") {
    return {
      fleetCatalogEnabled: input.ownerControlPlane.fleetCatalogEnabled,
      operatorProfileId: input.ownerControlPlane.operatorProfileId,
      fleetCatalogBlockedCode: input.ownerControlPlane.fleetCatalogBlockedCode,
      humanPrincipalId: input.ownerControlPlane.humanPrincipalId
    };
  }
  const workspaceHumanPrincipalId = resolveDesktopHumanPrincipalId({
    collaborationStatus: input.collaborationStatus,
    membershipHumanPrincipalId:
      resolveCurrentMembership({
        members: input.collaborationMembers,
        status: input.collaborationStatus
      })?.humanPrincipalId ?? null
  });
  const workspaceProfile = input.collaborationStatus?.profiles.find(
    (profile) => profile.profileId === locator.connectionProfileId
  );
  return {
    ...deriveCanvasFleetCatalogAuthority({
      status: input.ownerControlPlane.status,
      workspaceServerBaseUrl: workspaceProfile?.serverBaseUrl ?? null,
      preferredProfileId: locator.connectionProfileId
    }),
    humanPrincipalId: workspaceHumanPrincipalId
  };
}

export function deriveFleetCatalogBlockedCode(
  status: OperatorControlStatus | null,
  options?: { bridgeAvailable?: boolean }
): string | null {
  const bridgeAvailable = options?.bridgeAvailable ?? Boolean(operatorControlBridge);
  if (!bridgeAvailable) return "operator_bridge_unavailable";
  if (!status?.activeProfileId) return "operator_profile_not_active";
  const active = status.profiles.find((profile) => profile.profileId === status.activeProfileId);
  if (!active) return "operator_profile_not_found";
  if (!active.hasOperatorCredential) return "operator_credential_missing";
  if (active.hostedByThisDesktop && status.lastErrorCode === "operator_local_server_not_ready") {
    return status.lastErrorCode;
  }
  return null;
}

export function useOwnerControlPlaneAvailability(): OwnerControlPlaneAvailability {
  const [status, setStatus] = useState<OperatorControlStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!operatorControlBridge) {
      setStatus(null);
      return;
    }
    setStatus(await operatorControlBridge.getOperatorControlStatus());
  }, []);

  useEffect(() => {
    void refresh();
    if (!operatorControlBridge) return;
    return operatorControlBridge.onOperatorControlStatusChanged((next) => setStatus(next));
  }, [refresh]);

  const operatorProfileId = status?.activeProfileId ?? null;
  const humanPrincipalId =
    status?.profiles.find((profile) => profile.profileId === operatorProfileId)?.humanPrincipalId ??
    null;
  const fleetCatalogBlockedCode = deriveFleetCatalogBlockedCode(status);
  const fleetCatalogEnabled = fleetCatalogBlockedCode === null;

  return useMemo(
    () => ({
      fleetCatalogEnabled,
      operatorProfileId,
      humanPrincipalId,
      fleetCatalogBlockedCode,
      status,
      refresh
    }),
    [
      fleetCatalogBlockedCode,
      fleetCatalogEnabled,
      humanPrincipalId,
      operatorProfileId,
      refresh,
      status
    ]
  );
}
