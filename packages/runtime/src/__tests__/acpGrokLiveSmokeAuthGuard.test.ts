import type { AuthMethod } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { coordinateAcpAuthentication } from "../autoRun/acpAuthentication.js";
import { createGrokLiveSmokeAuthGuard } from "./acpGrokLiveSmokeAuthGuard.js";

function createGuard(method: AuthMethod, environmentVariables: readonly string[] = []) {
  const realAuthenticate = vi.fn().mockResolvedValue({});
  return {
    realAuthenticate,
    guard: createGrokLiveSmokeAuthGuard({
      connection: { authenticate: realAuthenticate },
      authMethods: [method],
      availableEnvironmentVariables: new Set(environmentVariables),
      reject: (status) => new Error(status)
    })
  };
}

describe("Grok ACP live smoke authentication guard", () => {
  it("delegates the prevalidated cached-token request unchanged", async () => {
    const method: AuthMethod = { id: "cached_token", name: "Cached token" };
    const { guard, realAuthenticate } = createGuard(method);

    const request = { methodId: "cached_token" };
    const options = { timeoutMs: 123 };
    await guard.connection.authenticate(request, options);

    expect(realAuthenticate).toHaveBeenCalledOnce();
    expect(realAuthenticate).toHaveBeenCalledWith(request, options);
    expect(guard.delegatedMethodId()).toBe("cached_token");
  });

  it("rejects an advertised but unapproved env method before real authenticate", async () => {
    const method: AuthMethod = {
      id: "future_provider_token",
      name: "Future provider token",
      type: "env_var",
      vars: [{ name: "FUTURE_PROVIDER_TOKEN" }]
    };
    const initialized = { authMethods: [method] };
    const availableEnvironmentVariables = new Set(["FUTURE_PROVIDER_TOKEN"]);
    const { guard, realAuthenticate } = createGuard(method, ["FUTURE_PROVIDER_TOKEN"]);

    await expect(
      coordinateAcpAuthentication({
        connection: guard.connection,
        initialized,
        hints: {
          preferredMethodIds: ["future_provider_token"],
          headlessSafeMethodIds: ["cached_token"]
        },
        availableEnvironmentVariables
      })
    ).rejects.toThrow("requested_method_not_live_smoke_safe");
    expect(realAuthenticate).not.toHaveBeenCalled();
    expect(guard.delegatedMethodId()).toBeNull();
  });
});

describe("Grok ACP live smoke cached-token type guard", () => {
  it("rejects an env method that reuses the cached-token id before real authenticate", () => {
    const method: AuthMethod = {
      id: "cached_token",
      name: "Misleading cached token",
      type: "env_var",
      vars: [{ name: "FUTURE_PROVIDER_TOKEN" }]
    };
    const { guard, realAuthenticate } = createGuard(method, ["FUTURE_PROVIDER_TOKEN"]);

    expect(() => guard.connection.authenticate({ methodId: "cached_token" })).toThrow(
      "requested_method_not_live_smoke_safe"
    );
    expect(realAuthenticate).not.toHaveBeenCalled();
    expect(guard.delegatedMethodId()).toBeNull();
  });

  it("rejects a terminal method that reuses the cached-token id before real authenticate", () => {
    const method: AuthMethod = {
      id: "cached_token",
      name: "Misleading terminal token",
      type: "terminal"
    };
    const { guard, realAuthenticate } = createGuard(method);

    expect(() => guard.connection.authenticate({ methodId: "cached_token" })).toThrow(
      "requested_method_not_live_smoke_safe"
    );
    expect(realAuthenticate).not.toHaveBeenCalled();
    expect(guard.delegatedMethodId()).toBeNull();
  });
});
