import { describe, expect, it, vi } from "vitest";
import {
  builtinAcpProfileCatalog,
  CatalogAcpProfileResolver,
  type AcpHostCommandResolver
} from "../acpProfile/resolver.js";
import {
  emptyAcpProfileCatalog,
  type AcpProfileCatalog,
  type AcpProfileDescriptor
} from "../acpProfile/schema.js";

const nativeHost = { kind: "native" } as const;
const commandResolver: AcpHostCommandResolver = {
  resolve: async (command) => `/resolved/${command.replaceAll("/", "-")}`
};

function localProfile(overrides: Partial<AcpProfileDescriptor> = {}): AcpProfileDescriptor {
  return {
    version: "planweave.acp-profile/v1",
    id: "custom-acp",
    agentId: "custom-agent",
    displayName: "Custom Agent",
    host: nativeHost,
    launch: { command: "custom-acp", args: ["serve"] },
    environment: [{ name: "CUSTOM_API_KEY", required: true }],
    shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1_000 },
    capabilities: { required: ["session", "prompt"], optional: ["cancel"] },
    connection: { mode: "dedicated" },
    ...overrides
  };
}

function reader(catalog: AcpProfileCatalog) {
  return { read: async () => catalog };
}

describe("ACP profile resolver", () => {
  it("adapts all five built-in ACP profiles to one resolved contract", async () => {
    const builtins = builtinAcpProfileCatalog(nativeHost);
    expect(builtins.map((profile) => profile.id)).toEqual([
      "codex-acp",
      "opencode-acp",
      "claude-code-acp",
      "pi-acp",
      "grok-acp"
    ]);
    expect(builtins.map((profile) => [profile.id, profile.launch])).toEqual([
      ["codex-acp", { command: "codex-acp", args: [] }],
      ["opencode-acp", { command: "opencode", args: ["acp"] }],
      ["claude-code-acp", { command: "claude-agent-acp", args: [] }],
      ["pi-acp", { command: "pi-acp", args: [] }],
      ["grok-acp", { command: "grok", args: ["--no-auto-update", "agent", "stdio"] }]
    ]);
    const resolver = new CatalogAcpProfileResolver(
      reader(emptyAcpProfileCatalog()),
      commandResolver
    );
    for (const profile of builtins) {
      await expect(
        resolver.resolve(
          { agentId: profile.agentId },
          { projectRoot: "/project", host: nativeHost }
        )
      ).resolves.toMatchObject({
        profileId: profile.id,
        agentId: profile.agentId,
        source: "builtin",
        host: nativeHost,
        launch: { args: profile.launch.args },
        connection: { mode: "dedicated" }
      });
    }
    await expect(
      resolver.resolve(
        { agentId: "codex", profileId: "CoDeX-AcP" },
        { projectRoot: "/project", host: nativeHost }
      )
    ).resolves.toMatchObject({ profileId: "codex-acp", source: "builtin" });
  });

  it("requires project trust when a package executor resolves a built-in profile", async () => {
    const verifyTrust = vi.fn(async () => false);
    const resolver = new CatalogAcpProfileResolver(
      reader(emptyAcpProfileCatalog()),
      commandResolver,
      verifyTrust
    );
    await expect(
      resolver.resolve(
        { agentId: "codex" },
        { projectRoot: "/project", host: nativeHost, requireCommandTrust: true }
      )
    ).rejects.toThrow("not trusted");
    expect(verifyTrust).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/project",
        resolvedCommand: "/resolved/codex-acp",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    );

    verifyTrust.mockResolvedValue(true);
    await expect(
      resolver.resolve(
        { agentId: "codex" },
        { projectRoot: "/project", host: nativeHost, requireCommandTrust: true }
      )
    ).resolves.toMatchObject({ source: "builtin", agentId: "codex" });
  });

  it("uses canonical set and record ordering for profile fingerprints", async () => {
    let catalog: AcpProfileCatalog = {
      version: "planweave.acp-profile-catalog/v1",
      revision: 1,
      profiles: [
        localProfile({
          launch: { command: "custom-acp", args: ["serve", "--v2"] },
          environment: [
            { name: "SECOND_VALUE", required: false },
            { name: "CUSTOM_API_KEY", required: true }
          ],
          sessionDefaults: {
            modeId: "default",
            configOptions: { zeta: true, alpha: "one" }
          },
          capabilities: {
            required: ["prompt", "session"],
            optional: ["image", "cancel"]
          }
        })
      ]
    };
    const trust = vi.fn(async () => true);
    const resolver = new CatalogAcpProfileResolver(
      { read: async () => catalog },
      commandResolver,
      trust
    );
    const first = await resolver.resolve(
      { agentId: "custom-agent", profileId: "custom-acp" },
      { projectRoot: "/project", host: nativeHost }
    );
    expect(first).toMatchObject({
      source: "local-user",
      launch: { command: "/resolved/custom-acp", args: ["serve", "--v2"] }
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.launch.args)).toBe(true);
    expect(trust).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: first.fingerprint }));

    catalog = {
      ...catalog,
      revision: 2,
      profiles: [
        localProfile({
          launch: { command: "custom-acp", args: ["serve", "--v2"] },
          environment: [
            { name: "CUSTOM_API_KEY", required: true },
            { name: "SECOND_VALUE", required: false }
          ],
          sessionDefaults: {
            modeId: "default",
            configOptions: { alpha: "one", zeta: true }
          },
          capabilities: {
            required: ["session", "prompt"],
            optional: ["cancel", "image"]
          }
        })
      ]
    };
    const second = await resolver.resolve(
      { agentId: "custom-agent", profileId: "custom-acp" },
      { projectRoot: "/project", host: nativeHost }
    );
    expect(second.fingerprint).toBe(first.fingerprint);

    const sameProfile = catalog.profiles[0];
    if (!sameProfile) throw new Error("expected the fingerprint fixture profile");
    catalog = {
      ...catalog,
      revision: 3,
      profiles: [{ ...sameProfile, launch: { command: "custom-acp", args: ["--v2", "serve"] } }]
    };
    const changed = await resolver.resolve(
      { agentId: "custom-agent", profileId: "custom-acp" },
      { projectRoot: "/project", host: nativeHost }
    );
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("fails closed for identity, host, trust, missing profile, and built-in collisions", async () => {
    const catalog: AcpProfileCatalog = {
      version: "planweave.acp-profile-catalog/v1",
      revision: 1,
      profiles: [localProfile()]
    };
    const untrusted = new CatalogAcpProfileResolver(
      reader(catalog),
      commandResolver,
      async () => false
    );
    await expect(
      untrusted.resolve(
        { agentId: "wrong-agent", profileId: "custom-acp" },
        { projectRoot: "/project", host: nativeHost }
      )
    ).rejects.toThrow("belongs to agent");
    await expect(
      untrusted.resolve(
        { agentId: "custom-agent", profileId: "custom-acp" },
        { projectRoot: "/project", host: { kind: "wsl", distribution: "Ubuntu" } }
      )
    ).rejects.toThrow("execution host");
    await expect(
      untrusted.resolve(
        { agentId: "custom-agent", profileId: "custom-acp" },
        { projectRoot: "/project", host: nativeHost }
      )
    ).rejects.toThrow("not trusted");
    await expect(
      untrusted.resolve(
        { agentId: "custom-agent", profileId: "missing-acp" },
        { projectRoot: "/project", host: nativeHost }
      )
    ).rejects.toThrow("not registered");

    for (const localProfileId of ["codex-acp", "CoDeX-AcP"]) {
      const collision = new CatalogAcpProfileResolver(
        reader({
          ...catalog,
          profiles: [localProfile({ id: localProfileId, agentId: "codex" })]
        }),
        commandResolver,
        async () => true
      );
      for (const referenceProfileId of ["codex-acp", "CoDeX-AcP"]) {
        await expect(
          collision.resolve(
            { agentId: "codex", profileId: referenceProfileId },
            { projectRoot: "/project", host: nativeHost }
          )
        ).rejects.toThrow("conflicts with a built-in");
      }
    }
  });

  it("requires the host command adapter to prove an absolute command", async () => {
    const resolver = new CatalogAcpProfileResolver(reader(emptyAcpProfileCatalog()), {
      resolve: async (command) => command
    });
    await expect(
      resolver.resolve({ agentId: "codex" }, { projectRoot: "/project", host: nativeHost })
    ).rejects.toThrow("absolute command path");
  });
});
