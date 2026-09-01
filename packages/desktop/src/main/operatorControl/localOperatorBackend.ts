import { OperatorControlError } from "../../shared/operatorControl.js";

/** Main-owned Operator profile id written by LocalCollaborationCoordinator. */
export const LOCAL_OPERATOR_PROFILE_ID = "planweave-local-loopback";

export const LOCAL_OPERATOR_BACKEND_READY_TIMEOUT_MS = 15_000;

export type LocalOperatorBackendSnapshot = {
  running: boolean;
  /** Direct loopback HTTP base when the Desktop-hosted server is listening. */
  loopbackBaseUrl: string | null;
  /** Advertised origin hosts / invites use (Tailscale / LAN / loopback). */
  advertisedOrigin: string | null;
};

export type LocalOperatorBackendPort = {
  getSnapshot(): LocalOperatorBackendSnapshot;
  whenRunning(timeoutMs: number): Promise<LocalOperatorBackendSnapshot>;
};

let registeredBackend: LocalOperatorBackendPort | null = null;

export function setLocalOperatorBackendPort(port: LocalOperatorBackendPort | null): void {
  registeredBackend = port;
}

export function getLocalOperatorBackendPort(): LocalOperatorBackendPort | null {
  return registeredBackend;
}

export function isLocalOwnedOperatorProfile(
  profile: { profileId: string; serverBaseUrl: string },
  _snapshot: LocalOperatorBackendSnapshot | null
): boolean {
  return profile.profileId === LOCAL_OPERATOR_PROFILE_ID;
}

/**
 * Runtime-only base URL for Operator HTTP. Never persists loopback into the profile store.
 * Local-owned profiles talk to 127.0.0.1 to avoid Tailscale hairpin 502 during Desktop restart.
 */
export async function resolveEffectiveOperatorServerBaseUrl(input: {
  profile: { profileId: string; serverBaseUrl: string; allowInsecureTransport: boolean };
  backend?: LocalOperatorBackendPort | null;
  readyTimeoutMs?: number;
}): Promise<{ serverBaseUrl: string; allowInsecureTransport: boolean }> {
  const backend = input.backend === undefined ? getLocalOperatorBackendPort() : input.backend;
  if (!backend) {
    return {
      serverBaseUrl: input.profile.serverBaseUrl,
      allowInsecureTransport: input.profile.allowInsecureTransport
    };
  }

  let snapshot = backend.getSnapshot();
  if (!isLocalOwnedOperatorProfile(input.profile, snapshot)) {
    return {
      serverBaseUrl: input.profile.serverBaseUrl,
      allowInsecureTransport: input.profile.allowInsecureTransport
    };
  }

  if (!snapshot.running || !snapshot.loopbackBaseUrl) {
    try {
      snapshot = await backend.whenRunning(
        input.readyTimeoutMs ?? LOCAL_OPERATOR_BACKEND_READY_TIMEOUT_MS
      );
    } catch (error) {
      if (error instanceof OperatorControlError) throw error;
      throw new OperatorControlError({
        kind: "offline",
        code: "operator_local_server_not_ready",
        cause: error
      });
    }
  }

  if (!snapshot.running || !snapshot.loopbackBaseUrl) {
    throw new OperatorControlError({
      kind: "offline",
      code: "operator_local_server_not_ready"
    });
  }

  return {
    serverBaseUrl: snapshot.loopbackBaseUrl,
    allowInsecureTransport: true
  };
}
