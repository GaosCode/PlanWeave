import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS,
  type HostCredentialLifetimeDays
} from "@planweave-ai/agent-host-protocol/browser";
import type { OperatorHostView } from "@planweave-ai/agent-host-protocol/operator-control";
import {
  OperatorControlError,
  type OperatorHostBootstrapHandoffView,
  type OperatorMemberSetupCodeHandoffView,
  type OperatorControlProfileInput,
  type OperatorControlStatus,
  type OperatorLocalAgentHostStatus,
  type OperatorProfileView
} from "../../shared/operatorControl";
import { operatorControlBridge } from "../bridge";
import {
  HOST_INVENTORY_PAGE_SIZE,
  mergeHostInventory,
  readHostInventoryBatch,
  type HostInventoryBatch
} from "../settings/hostInventoryPagination";
import { createHostInventoryOperationCoordinator } from "../settings/hostInventoryOperationCoordinator";

export type HostAdministrationLoadState = "loading" | "ready" | "unavailable";
export type HostInventoryState =
  | "loading"
  | "ready"
  | "profile_missing"
  | "credential_missing"
  | "unavailable";

type HostInventorySnapshot = HostInventoryBatch & {
  profileId: string;
  authorityGeneration: number;
  displayedHosts: OperatorHostView[];
  preservedHosts: OperatorHostView[];
};

type HostInventoryAuthority = {
  generation: number;
  identity: string;
  profileId: string | undefined;
};

export type HostAdministrationController = {
  status: OperatorControlStatus | null;
  hosts: OperatorHostView[];
  activeProfile: OperatorProfileView | null;
  loadState: HostAdministrationLoadState;
  hostInventoryState: HostInventoryState;
  hostsLoading: boolean;
  hostsHasMore: boolean;
  busy: boolean;
  error: string | null;
  handoff: OperatorHostBootstrapHandoffView | null;
  memberSetupCodeHandoff: OperatorMemberSetupCodeHandoffView | null;
  localAgentHost: OperatorLocalAgentHostStatus | null;
  localAgentHostLoading: boolean;
  credentialLifetimeDays: HostCredentialLifetimeDays;
  refresh: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  loadMoreHosts: () => Promise<void>;
  saveProfile: (profile: OperatorControlProfileInput) => Promise<boolean>;
  removeProfile: (profileId: string) => Promise<boolean>;
  selectProfile: (profileId: string) => Promise<boolean>;
  clearActiveProfile: () => Promise<boolean>;
  importCredential: (profileId: string, operatorId?: string) => Promise<boolean>;
  clearCredential: (profileId: string) => Promise<boolean>;
  copyBootstrapHandoff: () => Promise<OperatorHostBootstrapHandoffView | null>;
  copyMemberSetupCode: () => Promise<OperatorMemberSetupCodeHandoffView | null>;
  revokeHost: (hostId: string) => Promise<OperatorHostView | null>;
  renewHostCredential: (hostId: string) => Promise<OperatorHostView | null>;
  setCredentialLifetimeDays: (days: HostCredentialLifetimeDays) => void;
  registerLocalAgentHost: (
    exposedProfileIds: readonly string[]
  ) => Promise<OperatorLocalAgentHostStatus | null>;
  repairLocalAgentHost: (
    exposedProfileIds: readonly string[]
  ) => Promise<OperatorLocalAgentHostStatus | null>;
  enrollLocalAgentHost: (
    handoff: string,
    exposedProfileIds: readonly string[]
  ) => Promise<OperatorLocalAgentHostStatus | null>;
  dismissHandoff: () => void;
  dismissMemberSetupCodeHandoff: () => void;
  clearError: () => void;
};

const knownErrorCodes = new Set([
  "operator_bridge_unavailable",
  "operator_credential_missing",
  "operator_profile_missing",
  "operator_profile_not_found",
  "operator_offline",
  "operator_timeout",
  "operator_unauthorized",
  "operator_credential_invalid",
  "operator_admin_required",
  "operator_server_admin_required",
  "operator_forbidden",
  "operator_host_pagination_cursor_repeated",
  "operator_host_pagination_cursor_regressed",
  "operator_host_pagination_page_too_large",
  "local_agent_host_unavailable",
  "local_agent_host_custom_ca_unsupported",
  "local_agent_host_handoff_invalid",
  "local_agent_host_handoff_expired",
  "agent_host_enrollment_rejected",
  "agent_host_enrollment_exchange_failed",
  "agent_host_enrollment_transport_insecure",
  "agent_host_enrollment_transport_unsupported",
  "agent_host_enrollment_response_malformed",
  "agent_host_enrollment_response_too_large",
  "agent_host_enrollment_response_mismatch",
  "agent_host_enrollment_response_expired",
  "agent_host_enrollment_already_pending",
  "agent_host_handoff_config_conflict",
  "agent_host_handoff_pending_conflict",
  "agent_host_handoff_credential_conflict",
  "agent_host_handoff_provenance_invalid",
  "agent_host_windows_user_sid_unavailable",
  "agent_host_preset_binary_missing",
  "agent_host_background_setup_required"
]);

function knownErrorCode(value: string): string | null {
  for (const code of knownErrorCodes) {
    if (value === code || value.includes(`: ${code}`)) return code;
  }
  return null;
}

function safeAgentHostErrorCode(value: string): string | null {
  return value.match(/(?:agent_host|local_agent_host)_[a-z0-9_]+/)?.[0] ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof OperatorControlError && knownErrorCodes.has(error.code)) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && knownErrorCodes.has(code)) return code;
  }
  if (error instanceof Error) {
    return (
      knownErrorCode(error.message) ??
      safeAgentHostErrorCode(error.message) ??
      "operator_request_failed"
    );
  }
  return "operator_request_failed";
}

function nextExpiry(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function useHostAdministrationController(): HostAdministrationController {
  const [status, setStatus] = useState<OperatorControlStatus | null>(null);
  const [hostSnapshot, setHostSnapshot] = useState<HostInventorySnapshot | null>(null);
  const [loadState, setLoadState] = useState<HostAdministrationLoadState>("loading");
  const [hostInventoryState, setHostInventoryState] = useState<HostInventoryState>("loading");
  const [hostsLoading, setHostsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<OperatorHostBootstrapHandoffView | null>(null);
  const [memberSetupCodeHandoff, setMemberSetupCodeHandoff] =
    useState<OperatorMemberSetupCodeHandoffView | null>(null);
  const [localAgentHost, setLocalAgentHost] = useState<OperatorLocalAgentHostStatus | null>(null);
  const [localAgentHostLoading, setLocalAgentHostLoading] = useState(false);
  const [credentialLifetimeDays, setCredentialLifetimeDays] = useState<HostCredentialLifetimeDays>(
    DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS
  );

  const refresh = useCallback(async () => {
    if (!operatorControlBridge) {
      setLoadState("unavailable");
      setError("operator_bridge_unavailable");
      return;
    }
    setLoadState("loading");
    try {
      setStatus(await operatorControlBridge.getOperatorControlStatus());
      setError(null);
      setLoadState("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setLoadState("ready");
    }
  }, []);

  const activeProfile = useMemo(
    () => status?.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null,
    [status]
  );
  const activeProfileId = activeProfile?.profileId;
  const activeProfileHasOperatorCredential = activeProfile?.hasOperatorCredential === true;
  const hostAuthorityIdentity = activeProfile
    ? [
        activeProfile.profileId,
        activeProfile.hasOperatorCredential ? "credential-present" : "credential-missing",
        activeProfile.operatorId ?? "",
        activeProfile.operatorCredentialPersistence,
        activeProfile.updatedAt
      ].join("\u0000")
    : `profile-missing\u0000${status?.activeProfileId ?? ""}`;
  const hostAuthorityRef = useRef<HostInventoryAuthority>({
    generation: 0,
    identity: hostAuthorityIdentity,
    profileId: activeProfileId
  });
  if (hostAuthorityRef.current.identity !== hostAuthorityIdentity) {
    hostAuthorityRef.current = {
      generation: hostAuthorityRef.current.generation + 1,
      identity: hostAuthorityIdentity,
      profileId: activeProfileId
    };
  }
  const previousActiveProfileId = useRef(activeProfile?.profileId);
  const hostSnapshotRef = useRef(hostSnapshot);
  hostSnapshotRef.current = hostSnapshot;
  const hostOperationCoordinator = useRef(createHostInventoryOperationCoordinator());
  const visibleHostSnapshot =
    activeProfileHasOperatorCredential &&
    hostSnapshot !== null &&
    hostSnapshot.profileId === activeProfileId &&
    hostSnapshot.authorityGeneration === hostAuthorityRef.current.generation
      ? hostSnapshot
      : null;
  const hosts = visibleHostSnapshot?.displayedHosts ?? [];
  const hostsHasMore = visibleHostSnapshot?.nextCursor !== null && visibleHostSnapshot !== null;

  useEffect(() => {
    const activeProfileId = activeProfile?.profileId;
    if (previousActiveProfileId.current !== activeProfileId) {
      previousActiveProfileId.current = activeProfileId;
      setMemberSetupCodeHandoff(null);
    }
  }, [activeProfile?.profileId]);

  const readHosts = useCallback(
    (options: { mode: "refresh" | "continue"; silent?: boolean }): Promise<void> => {
      if (!operatorControlBridge) {
        hostSnapshotRef.current = null;
        setHostSnapshot(null);
        setHostsLoading(false);
        setHostInventoryState("unavailable");
        return Promise.resolve();
      }
      if (!status) {
        hostSnapshotRef.current = null;
        setHostSnapshot(null);
        setHostsLoading(false);
        setHostInventoryState(loadState === "loading" ? "loading" : "unavailable");
        return Promise.resolve();
      }
      if (!activeProfileId) {
        hostSnapshotRef.current = null;
        setHostSnapshot(null);
        setHostsLoading(false);
        setHostInventoryState("profile_missing");
        return Promise.resolve();
      }
      if (!activeProfileHasOperatorCredential) {
        hostSnapshotRef.current = null;
        setHostSnapshot(null);
        setHostsLoading(false);
        setHostInventoryState("credential_missing");
        return Promise.resolve();
      }
      const requestAuthority = hostAuthorityRef.current;
      const profileId = activeProfileId;
      const bridge = operatorControlBridge;
      const authorityKey = `${profileId}\u0000${requestAuthority.generation}`;
      return hostOperationCoordinator.current.run(authorityKey, options.mode, async () => {
        const currentAuthority = hostAuthorityRef.current;
        if (
          currentAuthority.generation !== requestAuthority.generation ||
          currentAuthority.identity !== requestAuthority.identity ||
          currentAuthority.profileId !== requestAuthority.profileId
        ) {
          return;
        }
        if (!options.silent) {
          setHostsLoading(true);
          if (options.mode === "refresh") setHostInventoryState("loading");
        }
        const currentSnapshot = hostSnapshotRef.current;
        const continuationSnapshot =
          options.mode === "continue" &&
          currentSnapshot?.profileId === profileId &&
          currentSnapshot.authorityGeneration === requestAuthority.generation
            ? currentSnapshot
            : null;
        if (options.mode === "continue" && continuationSnapshot?.nextCursor === null) {
          setHostsLoading(false);
          return;
        }
        const cursor = continuationSnapshot?.nextCursor ?? 0;
        try {
          const batch = await readHostInventoryBatch({
            cursor,
            hosts: continuationSnapshot?.hosts ?? [],
            requestedCursors: continuationSnapshot?.requestedCursors ?? new Set<number>(),
            readPage: (pageCursor) =>
              bridge.listOperatorHosts({
                profileId,
                query: { cursor: pageCursor, limit: HOST_INVENTORY_PAGE_SIZE }
              })
          });
          if (hostAuthorityRef.current.generation !== requestAuthority.generation) return;
          const preservedHosts =
            options.mode === "continue"
              ? (continuationSnapshot?.preservedHosts ?? [])
              : options.silent &&
                  currentSnapshot?.profileId === profileId &&
                  currentSnapshot.authorityGeneration === requestAuthority.generation
                ? currentSnapshot.displayedHosts
                : [];
          const nextSnapshot: HostInventorySnapshot = {
            ...batch,
            profileId,
            authorityGeneration: requestAuthority.generation,
            preservedHosts: batch.nextCursor === null ? [] : preservedHosts,
            displayedHosts:
              batch.nextCursor === null
                ? batch.hosts
                : mergeHostInventory(preservedHosts, batch.hosts)
          };
          hostSnapshotRef.current = nextSnapshot;
          setHostSnapshot(nextSnapshot);
          setHostInventoryState("ready");
          setError(null);
        } catch (cause) {
          if (hostAuthorityRef.current.generation !== requestAuthority.generation) return;
          const authoritativeSnapshot = hostSnapshotRef.current;
          setHostInventoryState(
            authoritativeSnapshot?.profileId === profileId &&
              authoritativeSnapshot.authorityGeneration === requestAuthority.generation
              ? "ready"
              : "unavailable"
          );
          setError(errorMessage(cause));
        } finally {
          if (
            !options.silent &&
            hostAuthorityRef.current.generation === requestAuthority.generation
          ) {
            setHostsLoading(false);
          }
        }
      });
    },
    [activeProfileId, activeProfileHasOperatorCredential, loadState, status]
  );

  const refreshHosts = useCallback(
    (options?: { silent?: boolean }) => readHosts({ mode: "refresh", silent: options?.silent }),
    [readHosts]
  );

  const loadMoreHosts = useCallback(() => readHosts({ mode: "continue" }), [readHosts]);

  useEffect(() => {
    void refresh();
    if (!operatorControlBridge) return;
    return operatorControlBridge.onOperatorControlStatusChanged((next) => setStatus(next));
  }, [refresh]);

  useEffect(() => {
    void refreshHosts();
  }, [refreshHosts]);

  useEffect(() => {
    if (!activeProfileId || !activeProfileHasOperatorCredential) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refreshHosts({ silent: true });
      if (!cancelled) timer = setTimeout(() => void poll(), 5_000);
    };
    timer = setTimeout(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeProfileHasOperatorCredential, activeProfileId, refreshHosts]);

  useEffect(() => {
    if (!operatorControlBridge) {
      setLocalAgentHost(null);
      return;
    }
    let active = true;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const loadLocalAgentHost = (options?: { silent?: boolean }) => {
      if (!options?.silent) setLocalAgentHostLoading(true);
      return operatorControlBridge!
        .getOperatorLocalAgentHostStatus(activeProfileId ? { profileId: activeProfileId } : {})
        .then((next) => {
          if (active) setLocalAgentHost(next);
        })
        .catch((cause) => {
          if (active && !options?.silent) setError(errorMessage(cause));
        })
        .finally(() => {
          if (active && !options?.silent) setLocalAgentHostLoading(false);
        });
    };

    void loadLocalAgentHost();
    // Refresh connection-status.json while Host is registered so process vs Server state stays current.
    pollTimer = setInterval(() => {
      void loadLocalAgentHost({ silent: true });
    }, 5_000);

    return () => {
      active = false;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [activeProfileId]);

  const runStatusAction = useCallback(
    async (action: () => Promise<OperatorControlStatus>): Promise<boolean> => {
      if (!operatorControlBridge) {
        setError("operator_bridge_unavailable");
        return false;
      }
      setBusy(true);
      try {
        setStatus(await action());
        setError(null);
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const saveProfile = useCallback(
    (profile: OperatorControlProfileInput) =>
      runStatusAction(() => operatorControlBridge!.upsertOperatorProfile(profile)),
    [runStatusAction]
  );

  const removeProfile = useCallback(
    (profileId: string) =>
      runStatusAction(() => operatorControlBridge!.removeOperatorProfile({ profileId })),
    [runStatusAction]
  );

  const selectProfile = useCallback(
    (profileId: string) =>
      runStatusAction(() => operatorControlBridge!.setActiveOperatorProfile({ profileId })),
    [runStatusAction]
  );

  const clearActiveProfile = useCallback(
    () => runStatusAction(() => operatorControlBridge!.clearActiveOperatorProfile()),
    [runStatusAction]
  );

  const importCredential = useCallback(
    (profileId: string, operatorId?: string) =>
      runStatusAction(() =>
        operatorControlBridge!.importOperatorCredential({
          profileId,
          ...(operatorId?.trim() ? { operatorId: operatorId.trim() } : {})
        })
      ),
    [runStatusAction]
  );

  const clearCredential = useCallback(
    (profileId: string) =>
      runStatusAction(() => operatorControlBridge!.clearOperatorCredential({ profileId })),
    [runStatusAction]
  );

  const copyBootstrapHandoff = useCallback(async () => {
    if (!operatorControlBridge || !activeProfile || !activeProfile.hasOperatorCredential) {
      setError("operator_credential_missing");
      return null;
    }
    setBusy(true);
    try {
      const result = await operatorControlBridge.copyOperatorHostBootstrapHandoff({
        profileId: activeProfile.profileId,
        request: {
          expiresAt: nextExpiry(15),
          credentialPolicy: { lifetimeDays: credentialLifetimeDays, renewal: "automatic" }
        }
      });
      setHandoff(result);
      setError(null);
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }, [activeProfile, credentialLifetimeDays]);

  const copyMemberSetupCode = useCallback(async () => {
    if (!operatorControlBridge || !activeProfile || !activeProfile.hasOperatorCredential) {
      setError("operator_credential_missing");
      return null;
    }
    setBusy(true);
    try {
      const result = await operatorControlBridge.copyOperatorMemberSetupCode({
        profileId: activeProfile.profileId
      });
      setMemberSetupCodeHandoff(result);
      setError(null);
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }, [activeProfile]);

  const revokeHost = useCallback(
    async (hostId: string) => {
      if (!operatorControlBridge || !activeProfile) {
        setError("operator_profile_missing");
        return null;
      }
      setBusy(true);
      try {
        const revoked = await operatorControlBridge.revokeOperatorHost({
          profileId: activeProfile.profileId,
          hostId
        });
        setHostSnapshot((current) => {
          if (
            current?.profileId !== activeProfile.profileId ||
            current.authorityGeneration !== hostAuthorityRef.current.generation
          ) {
            return current;
          }
          const next = {
            ...current,
            hosts: current.hosts.map((host) => (host.id === hostId ? revoked : host)),
            displayedHosts: current.displayedHosts.map((host) =>
              host.id === hostId ? revoked : host
            ),
            preservedHosts: current.preservedHosts.map((host) =>
              host.id === hostId ? revoked : host
            )
          };
          hostSnapshotRef.current = next;
          return next;
        });
        setError(null);
        return revoked;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfile]
  );

  const renewHostCredential = useCallback(
    async (hostId: string) => {
      if (!operatorControlBridge || !activeProfile) {
        setError("operator_profile_missing");
        return null;
      }
      setBusy(true);
      try {
        const renewed = await operatorControlBridge.renewOperatorHostCredential({
          profileId: activeProfile.profileId,
          hostId
        });
        setHostSnapshot((current) => {
          if (
            current?.profileId !== activeProfile.profileId ||
            current.authorityGeneration !== hostAuthorityRef.current.generation
          ) {
            return current;
          }
          const next = {
            ...current,
            hosts: current.hosts.map((host) => (host.id === hostId ? renewed : host)),
            displayedHosts: current.displayedHosts.map((host) =>
              host.id === hostId ? renewed : host
            ),
            preservedHosts: current.preservedHosts.map((host) =>
              host.id === hostId ? renewed : host
            )
          };
          hostSnapshotRef.current = next;
          return next;
        });
        setError(null);
        return renewed;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfile]
  );

  const registerLocalAgentHost = useCallback(
    async (exposedProfileIds: readonly string[]) => {
      if (!operatorControlBridge || !activeProfile || !activeProfile.hasOperatorCredential) {
        setError("operator_credential_missing");
        return null;
      }
      setBusy(true);
      try {
        const next = await operatorControlBridge.registerOperatorLocalAgentHost({
          profileId: activeProfile.profileId,
          request: {
            expiresAt: nextExpiry(15),
            credentialPolicy: { lifetimeDays: credentialLifetimeDays, renewal: "automatic" }
          },
          exposedProfileIds: [...exposedProfileIds]
        });
        setLocalAgentHost(next);
        setError(null);
        await refreshHosts();
        return next;
      } catch (cause) {
        setError(errorMessage(cause));
        try {
          setLocalAgentHost(
            await operatorControlBridge.getOperatorLocalAgentHostStatus({
              profileId: activeProfile.profileId
            })
          );
        } catch (statusCause) {
          console.warn(
            "Failed to refresh local Agent Host status after registration error.",
            statusCause
          );
        }
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfile, credentialLifetimeDays, refreshHosts]
  );

  const enrollLocalAgentHost = useCallback(
    async (handoff: string, exposedProfileIds: readonly string[]) => {
      if (!operatorControlBridge) {
        setError("operator_bridge_unavailable");
        return null;
      }
      setBusy(true);
      try {
        const next = await operatorControlBridge.enrollOperatorLocalAgentHost({
          handoff,
          exposedProfileIds: [...exposedProfileIds]
        });
        setLocalAgentHost(next);
        setError(null);
        await refreshHosts();
        return next;
      } catch (cause) {
        setError(errorMessage(cause));
        try {
          setLocalAgentHost(
            await operatorControlBridge.getOperatorLocalAgentHostStatus(
              activeProfileId ? { profileId: activeProfileId } : {}
            )
          );
        } catch (statusCause) {
          console.warn(
            "Failed to refresh local Agent Host status after enrollment error.",
            statusCause
          );
        }
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfileId, refreshHosts]
  );

  const repairLocalAgentHost = useCallback(
    async (exposedProfileIds: readonly string[]) => {
      if (!operatorControlBridge) {
        setError("operator_bridge_unavailable");
        return null;
      }
      setBusy(true);
      try {
        const next = await operatorControlBridge.repairOperatorLocalAgentHost({
          ...(activeProfileId ? { profileId: activeProfileId } : {}),
          exposedProfileIds: [...exposedProfileIds]
        });
        setLocalAgentHost(next);
        setError(null);
        await refreshHosts();
        return next;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfileId, refreshHosts]
  );

  return {
    status,
    hosts,
    activeProfile,
    loadState,
    hostInventoryState,
    hostsLoading,
    hostsHasMore,
    busy,
    error,
    handoff,
    memberSetupCodeHandoff,
    localAgentHost,
    localAgentHostLoading,
    credentialLifetimeDays,
    refresh,
    refreshHosts,
    loadMoreHosts,
    saveProfile,
    removeProfile,
    selectProfile,
    clearActiveProfile,
    importCredential,
    clearCredential,
    copyBootstrapHandoff,
    copyMemberSetupCode,
    revokeHost,
    renewHostCredential,
    setCredentialLifetimeDays,
    registerLocalAgentHost,
    repairLocalAgentHost,
    enrollLocalAgentHost,
    dismissHandoff: () => setHandoff(null),
    dismissMemberSetupCodeHandoff: () => setMemberSetupCodeHandoff(null),
    clearError: () => setError(null)
  };
}
