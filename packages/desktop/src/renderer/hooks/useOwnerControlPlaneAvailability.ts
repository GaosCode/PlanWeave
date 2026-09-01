import { useCallback, useEffect, useMemo, useState } from "react";
import type { OperatorControlStatus } from "../../shared/operatorControl";
import { operatorControlBridge } from "../bridge";

export type OwnerControlPlaneAvailability = {
  /** Active operator profile with a stored credential — fleet catalog may load. */
  fleetCatalogEnabled: boolean;
  operatorProfileId: string | null;
  /** Stable code when fleet catalog cannot load due to missing operator setup. */
  fleetCatalogBlockedCode: string | null;
  status: OperatorControlStatus | null;
  refresh: () => Promise<void>;
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

  return useMemo(
    () => ({
      fleetCatalogEnabled,
      operatorProfileId,
      fleetCatalogBlockedCode,
      status,
      refresh
    }),
    [fleetCatalogBlockedCode, fleetCatalogEnabled, operatorProfileId, refresh, status]
  );
}
