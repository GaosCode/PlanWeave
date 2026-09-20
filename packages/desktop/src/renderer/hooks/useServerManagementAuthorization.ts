import { useEffect, useState } from "react";
import type { OperatorControlStatus } from "../../shared/operatorControl";
import { operatorControlBridge } from "../bridge";
import { hostAdministrationErrorCode } from "../settings/hostAdministrationErrors";

export function useServerManagementAuthorization() {
  const [status, setStatus] = useState<OperatorControlStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifiedId, setVerifiedId] = useState<string | null>(null);
  useEffect(() => {
    if (!operatorControlBridge) return;
    let active = true;
    const update = (next: OperatorControlStatus) => {
      if (active) setStatus(next);
    };
    const unsubscribe = operatorControlBridge.onOperatorControlStatusChanged(update);
    void operatorControlBridge.getOperatorControlStatus().then(update, (cause) => {
      if (active) setError(hostAdministrationErrorCode(cause));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const profileId = selectedId ?? status?.activeProfileId;
  const profile = status?.profiles.find((item) => item.profileId === profileId);
  const importCredential = async () => {
    if (!operatorControlBridge || !profile || busy) return;
    setBusy(true);
    setError(null);
    setVerifiedId(null);
    try {
      const next = await operatorControlBridge.importOperatorCredential({
        profileId: profile.profileId,
        verifyBeforeSave: true
      });
      setStatus(next);
      setVerifiedId(profile.profileId);
    } catch (cause) {
      setError(hostAdministrationErrorCode(cause));
    } finally {
      setBusy(false);
    }
  };
  return {
    status,
    profileId,
    profile,
    busy,
    error,
    verifiedId,
    importCredential,
    selectProfile: (id: string) => {
      setSelectedId(id);
      setError(null);
      setVerifiedId(null);
    }
  };
}
