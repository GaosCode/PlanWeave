import type { AuthMethod, InitializeResponse } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  acpAuthenticationHintsSchema,
  acpAuthenticationOutcomeSchema,
  acpAuthenticationPlanSchema,
  coordinateAcpAuthentication,
  normalizeAcpAuthMethods,
  planAcpAuthentication
} from "../autoRun/acpAuthentication.js";
import { capabilitiesFromInitialize } from "../autoRun/acpPreflightProbe.js";

const agentMethod = (id = "agent-login"): AuthMethod => ({ id, name: `Agent ${id}` });
const terminalMethod = (id = "terminal-login"): AuthMethod => ({
  id,
  name: `Terminal ${id}`,
  type: "terminal",
  args: ["interactive-command-secret"],
  env: Object.fromEntries([["OPAQUE_TOKEN", "must-not-leak"]]),
  _meta: { token: "must-not-leak" }
});
const envMethod = (
  id = "api-key",
  variables: Array<{ name: string; optional?: boolean; secret?: boolean }> = [{ name: "API_KEY" }]
): AuthMethod => ({
  id,
  name: `Environment ${id}`,
  type: "env_var",
  vars: variables,
  link: "https://example.test/credentials",
  _meta: { token: "must-not-leak" }
});

function normalize(methods: readonly AuthMethod[], available: readonly string[] = []) {
  return normalizeAcpAuthMethods(methods, new Set(available));
}

describe("ACP authentication method projection", () => {
  it("projects only safe fields and treats a missing type as agent authentication", () => {
    const projected = normalize([
      {
        ...agentMethod(),
        description: "Authorization: Bearer must-not-leak",
        _meta: { token: "must-not-leak" }
      },
      terminalMethod()
    ]);

    expect(projected).toEqual([
      { id: "agent-login", name: "Agent agent-login", type: "agent" },
      { id: "terminal-login", name: "Terminal terminal-login", type: "terminal" }
    ]);
    expect(JSON.stringify(projected)).not.toContain("must-not-leak");
    expect(JSON.stringify(projected)).not.toContain("interactive-command-secret");
  });

  it("exposes required and missing variable names without values or optional variables", () => {
    const projected = normalize(
      [
        envMethod("api-key", [
          { name: "API_KEY", secret: true },
          { name: "ACCOUNT_ID", secret: false },
          { name: "OPTIONAL_REGION", optional: true }
        ])
      ],
      ["ACCOUNT_ID"]
    );

    expect(projected).toEqual([
      {
        id: "api-key",
        name: "Environment api-key",
        type: "env_var",
        requiredVariables: ["API_KEY", "ACCOUNT_ID"],
        missingVariables: ["API_KEY"],
        link: "https://example.test/credentials"
      }
    ]);
    expect(JSON.stringify(projected)).not.toContain("must-not-leak");
    expect(JSON.stringify(projected)).not.toContain("OPTIONAL_REGION");
  });

  it("preserves safe web links", () => {
    const link = "https://example.test/credentials?source=acp";
    const projected = normalize([{ ...envMethod(), link }]);

    expect(projected[0]).toMatchObject({ type: "env_var", link });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/plain,credential",
    "file:///tmp/credential",
    "https://user:password@example.test/credentials"
  ])("rejects unsafe authentication link %s", (link) => {
    expect(() => normalize([{ ...envMethod(), link }])).toThrow(/ACP authentication link must/);
  });
});

describe("ACP authentication planning", () => {
  it("proceeds only when no authentication methods were advertised", () => {
    expect(planAcpAuthentication([])).toEqual({
      kind: "proceed",
      reason: "no_auth_methods_advertised"
    });
  });

  it("authenticates only explicitly headless-safe agent methods", () => {
    const methods = normalize([agentMethod("cached-token")]);
    expect(
      planAcpAuthentication(methods, {
        preferredMethodIds: [],
        headlessSafeMethodIds: ["cached-token"]
      })
    ).toMatchObject({ kind: "authenticate", methodId: "cached-token" });
    expect(
      planAcpAuthentication(methods, {
        preferredMethodIds: [],
        headlessSafeMethodIds: []
      })
    ).toEqual({ kind: "user_action_required", reason: "no_safe_method", methods });
  });

  it("authenticates env_var methods only when every required variable exists", () => {
    const complete = normalize([envMethod()], ["API_KEY"]);
    expect(planAcpAuthentication(complete)).toMatchObject({
      kind: "authenticate",
      methodId: "api-key"
    });

    const missing = normalize([envMethod()]);
    expect(planAcpAuthentication(missing)).toEqual({
      kind: "user_action_required",
      reason: "missing_credentials",
      methods: missing
    });

    const optionalOnly = normalize([envMethod("optional", [{ name: "OPTIONAL", optional: true }])]);
    expect(planAcpAuthentication(optionalOnly)).toMatchObject({
      kind: "authenticate",
      methodId: "optional"
    });
  });
});

describe("ACP authentication action requirements", () => {
  it("never selects terminal authentication in headless mode", () => {
    const methods = normalize([terminalMethod()]);
    expect(
      planAcpAuthentication(methods, {
        preferredMethodIds: ["terminal-login"],
        headlessSafeMethodIds: ["terminal-login"]
      })
    ).toEqual({
      kind: "user_action_required",
      reason: "interactive_method",
      methods
    });
  });

  it("ignores unadvertised hints and continues evaluating advertised methods", () => {
    const methods = normalize([envMethod("advertised")], ["API_KEY"]);
    expect(
      planAcpAuthentication(methods, {
        preferredMethodIds: ["not-advertised"],
        headlessSafeMethodIds: ["not-advertised"]
      })
    ).toMatchObject({ kind: "authenticate", methodId: "advertised" });
  });

  it("uses preferred advertised order for multiple safe methods", () => {
    const methods = normalize(
      [agentMethod("first-advertised"), agentMethod("preferred"), envMethod("env")],
      ["API_KEY"]
    );
    expect(
      planAcpAuthentication(methods, {
        preferredMethodIds: ["preferred", "env"],
        headlessSafeMethodIds: ["first-advertised", "preferred"]
      })
    ).toMatchObject({ kind: "authenticate", methodId: "preferred" });
  });

  it("does not guess when multiple advertised methods have no safe option", () => {
    const methods = normalize([agentMethod(), terminalMethod()]);
    expect(planAcpAuthentication(methods)).toEqual({
      kind: "user_action_required",
      reason: "interactive_method",
      methods
    });
  });
});

describe("ACP authentication coordinator and contracts", () => {
  it("calls authenticate exactly once with the selected advertised method", async () => {
    const authenticate = vi.fn().mockResolvedValue({});
    await expect(
      coordinateAcpAuthentication({
        connection: { authenticate },
        initialized: { authMethods: [agentMethod("cached-token")] },
        hints: {
          preferredMethodIds: ["cached-token"],
          headlessSafeMethodIds: ["cached-token"]
        },
        availableEnvironmentVariables: new Set()
      })
    ).resolves.toEqual({ kind: "authenticated", methodId: "cached-token" });
    expect(authenticate).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledWith({ methodId: "cached-token" }, undefined);
  });

  it("does not call authenticate for proceed or user-action outcomes", async () => {
    const authenticate = vi.fn().mockResolvedValue({});
    await expect(
      coordinateAcpAuthentication({
        connection: { authenticate },
        initialized: {},
        availableEnvironmentVariables: new Set()
      })
    ).resolves.toEqual({ kind: "proceed" });
    await expect(
      coordinateAcpAuthentication({
        connection: { authenticate },
        initialized: { authMethods: [terminalMethod()] },
        availableEnvironmentVariables: new Set()
      })
    ).resolves.toMatchObject({ kind: "auth_required", reason: "interactive_method" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("preserves authenticate failures instead of converting them to auth_required", async () => {
    const failure = new Error("protocol authentication failed");
    await expect(
      coordinateAcpAuthentication({
        connection: { authenticate: vi.fn().mockRejectedValue(failure) },
        initialized: { authMethods: [envMethod()] },
        availableEnvironmentVariables: new Set(["API_KEY"])
      })
    ).rejects.toBe(failure);
  });
});

describe("ACP authentication public contracts", () => {
  it("uses strict Zod authorities for public hints, plans, and outcomes", () => {
    expect(
      acpAuthenticationHintsSchema.safeParse({
        preferredMethodIds: ["same", "same"],
        headlessSafeMethodIds: []
      }).success
    ).toBe(false);
    expect(
      acpAuthenticationPlanSchema.safeParse({
        kind: "proceed",
        reason: "no_auth_methods_advertised",
        secret: "not-allowed"
      }).success
    ).toBe(false);
    expect(acpAuthenticationOutcomeSchema.safeParse({ kind: "authenticated" }).success).toBe(false);
  });

  it("derives authentication capability from authMethods rather than logout", () => {
    const base: InitializeResponse = { protocolVersion: 1, agentCapabilities: {} };
    expect(capabilitiesFromInitialize({ ...base, authMethods: [agentMethod()] })).toContain(
      "authentication"
    );
    expect(
      capabilitiesFromInitialize({
        ...base,
        agentCapabilities: { auth: { logout: {} } },
        authMethods: []
      })
    ).not.toContain("authentication");
  });
});
