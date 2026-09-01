import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorControlError } from "../../shared/operatorControl.js";
import {
  LOCAL_OPERATOR_PROFILE_ID,
  isLocalOwnedOperatorProfile,
  resolveEffectiveOperatorServerBaseUrl,
  setLocalOperatorBackendPort,
  type LocalOperatorBackendPort,
  type LocalOperatorBackendSnapshot
} from "../main/operatorControl/localOperatorBackend.js";

afterEach(() => {
  setLocalOperatorBackendPort(null);
  vi.useRealTimers();
});

function snapshot(
  partial: Partial<LocalOperatorBackendSnapshot> = {}
): LocalOperatorBackendSnapshot {
  return {
    running: false,
    loopbackBaseUrl: null,
    advertisedOrigin: null,
    ...partial
  };
}

describe("localOperatorBackend resolution", () => {
  it("treats the main-owned profile id as local-owned", () => {
    expect(
      isLocalOwnedOperatorProfile(
        {
          profileId: LOCAL_OPERATOR_PROFILE_ID,
          serverBaseUrl: "https://owner-device.example.ts.net/"
        },
        snapshot()
      )
    ).toBe(true);
  });

  it("does not infer local ownership from a mutable advertised origin", () => {
    expect(
      isLocalOwnedOperatorProfile(
        {
          profileId: "other-profile",
          serverBaseUrl: "https://owner-device.example.ts.net/"
        },
        snapshot({ advertisedOrigin: "https://owner-device.example.ts.net/" })
      )
    ).toBe(false);
    expect(
      isLocalOwnedOperatorProfile(
        {
          profileId: "other-profile",
          serverBaseUrl: "https://remote.example.test/"
        },
        snapshot({ advertisedOrigin: "https://owner-device.example.ts.net/" })
      )
    ).toBe(false);
  });

  it("bypasses to loopback when the local backend is already running", async () => {
    const backend: LocalOperatorBackendPort = {
      getSnapshot: () =>
        snapshot({
          running: true,
          loopbackBaseUrl: "http://127.0.0.1:50653/",
          advertisedOrigin: "https://owner-device.example.ts.net/"
        }),
      whenRunning: vi.fn()
    };
    await expect(
      resolveEffectiveOperatorServerBaseUrl({
        profile: {
          profileId: LOCAL_OPERATOR_PROFILE_ID,
          serverBaseUrl: "https://owner-device.example.ts.net/",
          allowInsecureTransport: false
        },
        backend
      })
    ).resolves.toEqual({
      serverBaseUrl: "http://127.0.0.1:50653/",
      allowInsecureTransport: true
    });
    expect(backend.whenRunning).not.toHaveBeenCalled();
  });

  it("leaves remote operator profiles on their persisted URL", async () => {
    const backend: LocalOperatorBackendPort = {
      getSnapshot: () =>
        snapshot({
          running: true,
          loopbackBaseUrl: "http://127.0.0.1:50653/",
          advertisedOrigin: "https://owner-device.example.ts.net/"
        }),
      whenRunning: vi.fn()
    };
    await expect(
      resolveEffectiveOperatorServerBaseUrl({
        profile: {
          profileId: "remote-admin",
          serverBaseUrl: "https://remote.example.test/",
          allowInsecureTransport: false
        },
        backend
      })
    ).resolves.toEqual({
      serverBaseUrl: "https://remote.example.test/",
      allowInsecureTransport: false
    });
  });

  it("waits for local backend readiness then bypasses", async () => {
    const backend: LocalOperatorBackendPort = {
      getSnapshot: () => snapshot({ advertisedOrigin: "https://example.ts.net/" }),
      whenRunning: vi.fn(async () =>
        snapshot({
          running: true,
          loopbackBaseUrl: "http://127.0.0.1:4123/",
          advertisedOrigin: "https://example.ts.net/"
        })
      )
    };
    await expect(
      resolveEffectiveOperatorServerBaseUrl({
        profile: {
          profileId: LOCAL_OPERATOR_PROFILE_ID,
          serverBaseUrl: "https://example.ts.net/",
          allowInsecureTransport: false
        },
        backend,
        readyTimeoutMs: 1_000
      })
    ).resolves.toEqual({
      serverBaseUrl: "http://127.0.0.1:4123/",
      allowInsecureTransport: true
    });
    expect(backend.whenRunning).toHaveBeenCalledWith(1_000);
  });

  it("throws operator_local_server_not_ready when waiting times out", async () => {
    const backend: LocalOperatorBackendPort = {
      getSnapshot: () => snapshot(),
      whenRunning: vi.fn(async () => {
        throw new Error("operator_local_server_not_ready");
      })
    };
    await expect(
      resolveEffectiveOperatorServerBaseUrl({
        profile: {
          profileId: LOCAL_OPERATOR_PROFILE_ID,
          serverBaseUrl: "https://example.ts.net/",
          allowInsecureTransport: false
        },
        backend
      })
    ).rejects.toMatchObject({
      code: "operator_local_server_not_ready"
    } satisfies Partial<OperatorControlError>);
  });
});
