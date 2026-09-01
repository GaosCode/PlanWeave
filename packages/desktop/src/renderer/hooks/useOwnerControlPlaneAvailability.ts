import { useCallback, useEffect, useMemo, useState } from "react";
import type { OperatorControlStatus } from "../../shared/operatorControl";
import { operatorControlBridge } from "../bridge";

export type OwnerControlPlaneAvailability = {
  /** Active operator profile with a stored credential — fleet catalog may load. */
  fleetCatalogEnabled: boolean;
  operatorProfileId: string | null;
  /** Stable code when fleet catalog cannot load due to missing operator setup. */
  fleetCatalogBlockedCode: string | null;
  /** Local Canvas owner reads must stay on the Server hosted by this Desktop. */
  localFleetCatalogEnabled: boolean;
  localOperatorProfileId: string | null;
  localFleetCatalogBlockedCode: string | null;
  status: OperatorControlStatus | null;
  refresh: () => Promise<void>;
};

export type LocalOwnerFleetCatalogAccess = {
  enabled: boolean;
  operatorProfileId: string | null;
  blockedCode: string | null;
};

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

export function deriveLocalOwnerFleetCatalogAccess(
  status: OperatorControlStatus | null,
  options?: { bridgeAvailable?: boolean }
): LocalOwnerFleetCatalogAccess {
  const bridgeAvailable = options?.bridgeAvailable ?? Boolean(operatorControlBridge);
  if (!bridgeAvailable) {
    return {
      enabled: false,
      operatorProfileId: null,
      blockedCode: "operator_bridge_unavailable"
    };
  }
  const localProfile = status?.profiles.find((profile) => profile.hostedByThisDesktop) ?? null;
  if (!localProfile) {
    return {
      enabled: false,
      operatorProfileId: null,
      blockedCode: "operator_profile_not_found"
    };
  }
  if (!localProfile.hasOperatorCredential) {
    return {
      enabled: false,
      operatorProfileId: localProfile.profileId,
      blockedCode: "operator_credential_missing"
    };
  }
  if (status?.lastErrorCode === "operator_local_server_not_ready") {
    return {
      enabled: false,
      operatorProfileId: localProfile.profileId,
      blockedCode: status.lastErrorCode
    };
  }
  return { enabled: true, operatorProfileId: localProfile.profileId, blockedCode: null };
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
  const fleetCatalogBlockedCode = deriveFleetCatalogBlockedCode(status);
  const fleetCatalogEnabled = fleetCatalogBlockedCode === null;
  const localFleetCatalog = deriveLocalOwnerFleetCatalogAccess(status);

  return useMemo(
    () => ({
      fleetCatalogEnabled,
      operatorProfileId,
      fleetCatalogBlockedCode,
      localFleetCatalogEnabled: localFleetCatalog.enabled,
      localOperatorProfileId: localFleetCatalog.operatorProfileId,
      localFleetCatalogBlockedCode: localFleetCatalog.blockedCode,
      status,
      refresh
    }),
    [
      fleetCatalogBlockedCode,
      fleetCatalogEnabled,
      localFleetCatalog.blockedCode,
      localFleetCatalog.enabled,
      localFleetCatalog.operatorProfileId,
      operatorProfileId,
      refresh,
      status
    ]
  );
}
