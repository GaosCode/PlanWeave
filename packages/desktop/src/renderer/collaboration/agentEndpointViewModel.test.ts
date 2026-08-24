import { describe, expect, it } from "vitest";
import {
  applyAgentEndpointRequirements,
  agentEndpointDisplayLabel,
  buildAgentEndpointCatalog,
  buildAvailableAgentEndpoints,
  buildLocalAgentEndpoint,
  type LogicalAgentEndpointInput
} from "./agentEndpointViewModel";

describe("buildAgentEndpointCatalog", () => {
  it("keeps built-in, custom, and multiple same-family remote Endpoints together", () => {
    const endpoints = buildAgentEndpointCatalog({
      logicalExecutors: [
        {
          executorName: "codex",
          profileId: "codex",
          agentId: "codex",
          displayName: "Codex",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null,
          custom: false
        },
        {
          executorName: "custom-shell",
          profileId: "custom-shell",
          agentId: null,
          displayName: "custom-shell",
          capabilities: [],
          available: true,
          unavailableReason: null,
          custom: true
        }
      ],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-windows",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "available",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-vps",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([
      "local:codex",
      "local:custom-shell",
      "remote:endpoint-windows",
      "remote:endpoint-vps"
    ]);
    expect(endpoints.map(agentEndpointDisplayLabel)).toEqual([
      "Codex",
      "custom-shell",
      "Codex · LINANIML",
      "Codex · VPS"
    ]);
    expect(endpoints.map((endpoint) => endpoint.executorName)).toEqual([
      "codex",
      "custom-shell",
      "codex",
      "codex"
    ]);
  });

  it("keeps incompatible Endpoints visible but disabled", () => {
    const endpoints = applyAgentEndpointRequirements(
      buildAgentEndpointCatalog({
        logicalExecutors: [
          {
            executorName: "codex",
            profileId: "codex",
            agentId: "codex",
            displayName: "Codex",
            capabilities: [],
            available: true,
            unavailableReason: null,
            custom: false
          }
        ],
        remote: []
      }),
      ["acp.codex"]
    );

    expect(endpoints[0]).toMatchObject({
      id: "local:codex",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it("does not let a same-named custom logic executor claim a remote Agent profile", () => {
    const endpoints = buildAgentEndpointCatalog({
      logicalExecutors: [
        {
          executorName: "codex-acp",
          profileId: "codex-acp",
          agentId: null,
          displayName: "codex-acp",
          capabilities: [],
          available: true,
          unavailableReason: null,
          custom: true
        }
      ],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-windows",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints[1]).toMatchObject({
      id: "remote:endpoint-windows",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it("allows a registered built-in Endpoint before that executor appears in a Workspace canvas", () => {
    const endpoints = buildAgentEndpointCatalog({
      logicalExecutors: [
        {
          executorName: "pi",
          profileId: "pi",
          agentId: "pi",
          displayName: "Pi",
          capabilities: ["acp.pi"],
          available: true,
          unavailableReason: null,
          custom: false
        }
      ],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-mac-codex",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "Mac",
          status: "available",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-mac-opencode",
          profileId: "opencode-acp",
          agentId: "opencode",
          displayName: "OpenCode",
          hostDisplayName: "Mac",
          status: "available",
          capabilities: ["acp.opencode"]
        }
      ]
    });

    expect(endpoints.slice(1)).toEqual([
      expect.objectContaining({
        id: "remote:endpoint-mac-codex",
        executorName: "codex",
        available: true,
        unavailableReason: null
      }),
      expect.objectContaining({
        id: "remote:endpoint-mac-opencode",
        executorName: "opencode",
        available: true,
        unavailableReason: null
      })
    ]);
  });

  it("keeps an unmapped custom remote profile disabled", () => {
    const endpoints = buildAgentEndpointCatalog({
      logicalExecutors: [],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-custom-review",
          profileId: "custom-codex-review",
          agentId: "codex",
          displayName: "Codex Review",
          hostDisplayName: "Mac",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints[0]).toMatchObject({
      executorName: "codex",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it.each([
    ["codex-auto", "codex"],
    ["manual", "manual"]
  ])("keeps non-ACP built-in alias %s / %s disabled without a logical mapping", (profileId, agentId) => {
    const endpoints = buildAgentEndpointCatalog({
      logicalExecutors: [],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: `endpoint-${profileId}`,
          profileId,
          agentId,
          displayName: agentId,
          hostDisplayName: "Mac",
          status: "available",
          capabilities: []
        }
      ]
    });

    expect(endpoints[0]).toMatchObject({
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });
});

describe("buildLocalAgentEndpoint", () => {
  it.each([
    ["not run", false, null, null, true],
    ["loading", true, null, null, false],
    ["failure result", false, null, false, false],
    ["preflight error", false, "preflight failed", null, false],
    ["explicit success", false, null, true, true]
  ] as const)("keeps preflight optional but respects an observed %s state", (_name, preflightLoading, preflightError, preflightOk, available) => {
    expect(
      buildLocalAgentEndpoint({
        executorName: "codex-acp",
        displayName: "Codex",
        locationName: "This device",
        capabilities: ["acp.codex"],
        profileExists: true,
        detected: true,
        preflightLoading,
        preflightError,
        preflightOk
      })
    ).toMatchObject({
      available,
      unavailableReason: available ? null : "agent_endpoint_local_preflight_failed"
    });
  });
});

describe("remote endpoint executorName derivation", () => {
  const logicalExecutors: LogicalAgentEndpointInput[] = [
    {
      executorName: "codex",
      profileId: "codex",
      agentId: "codex",
      displayName: "Codex",
      capabilities: ["acp.codex"],
      available: true,
      unavailableReason: null,
      custom: false
    },
    {
      executorName: "grok",
      profileId: "grok",
      agentId: "grok",
      displayName: "Grok",
      capabilities: ["acp.grok"],
      available: true,
      unavailableReason: null,
      custom: false
    }
  ];

  const remote = [
    {
      schemaVersion: "agent-endpoint/v1" as const,
      endpointId: "endpoint-codex-host",
      profileId: "codex-acp",
      agentId: "codex" as const,
      displayName: "Codex",
      hostDisplayName: "LINANIML",
      status: "available" as const,
      capabilities: ["acp.codex"]
    },
    {
      schemaVersion: "agent-endpoint/v1" as const,
      endpointId: "endpoint-grok-host",
      profileId: "grok-acp",
      agentId: "grok" as const,
      displayName: "Grok",
      hostDisplayName: "VPS",
      status: "available" as const,
      capabilities: ["acp.grok"]
    }
  ];

  it("yields the same executorName from catalog and available-endpoint builders (§5.2-3)", () => {
    const fromCatalog = buildAgentEndpointCatalog({
      logicalExecutors,
      remote
    });
    const fromAvailable = buildAvailableAgentEndpoints({
      local: [],
      logicalExecutors,
      // Deliberately different from logical executorName — must not override derivation.
      requiredProfileId: "codex-acp",
      requiredAgentId: "codex",
      requiredCapabilities: [],
      remote
    });

    for (const endpointId of ["endpoint-codex-host", "endpoint-grok-host"] as const) {
      const catalogName = fromCatalog.find(
        (endpoint) => endpoint.remoteEndpointId === endpointId
      )?.executorName;
      const availableName = fromAvailable.find(
        (endpoint) => endpoint.remoteEndpointId === endpointId
      )?.executorName;
      expect(catalogName).toBeDefined();
      expect(availableName).toBe(catalogName);
    }

    expect(
      fromCatalog.find((endpoint) => endpoint.remoteEndpointId === "endpoint-codex-host")
        ?.executorName
    ).toBe("codex");
    expect(
      fromAvailable.find((endpoint) => endpoint.remoteEndpointId === "endpoint-codex-host")
        ?.executorName
    ).toBe("codex");
    expect(
      fromCatalog.find((endpoint) => endpoint.remoteEndpointId === "endpoint-grok-host")
        ?.executorName
    ).toBe("grok");
  });

  it("does not let requiredProfileId override remote executorName", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      logicalExecutors,
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex"],
      remote: [remote[0]]
    });

    expect(endpoints[0]).toMatchObject({
      id: "remote:endpoint-codex-host",
      executorName: "codex",
      available: true
    });
  });
});

describe("buildAvailableAgentEndpoints", () => {
  it("keeps local and remote instances distinct while suffixing only the remote Host", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [
        {
          executorName: "codex",
          displayName: "Codex",
          locationName: "This device",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null
        }
      ],
      logicalExecutors: [
        {
          executorName: "codex",
          profileId: "codex",
          agentId: "codex",
          displayName: "Codex",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null,
          custom: false
        }
      ],
      requiredProfileId: "codex",
      requiredAgentId: "codex",
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-windows",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([
      "local:codex",
      "remote:endpoint-windows"
    ]);
    expect(endpoints.map(agentEndpointDisplayLabel)).toEqual(["Codex", "Codex · LINANIML"]);
    expect(endpoints.map((endpoint) => endpoint.executorName)).toEqual(["codex", "codex"]);
    expect(endpoints.every((endpoint) => endpoint.available)).toBe(true);
  });

  it("does not let an Agent-family match override a custom profile identity", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      requiredProfileId: "custom-codex-review",
      requiredAgentId: null,
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-windows",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints[0]).toMatchObject({
      id: "remote:endpoint-windows",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it("merges all local candidates with compatible remote Endpoints", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [
        {
          executorName: "codex-acp",
          displayName: "Codex",
          locationName: "This device",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null
        },
        {
          executorName: "claude-acp",
          displayName: "Claude",
          locationName: "This device",
          capabilities: ["acp.claude-code"],
          available: true,
          unavailableReason: null
        }
      ],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-vps",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "available",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-other",
          profileId: "other-profile",
          agentId: "codex",
          displayName: "Other",
          hostDisplayName: "Build Mac",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints).toEqual([
      expect.objectContaining({ id: "local:codex-acp", source: "local", available: true }),
      expect.objectContaining({
        id: "local:claude-acp",
        source: "local",
        available: false,
        unavailableReason: "agent_endpoint_incompatible"
      }),
      expect.objectContaining({
        id: "remote:endpoint-vps",
        source: "remote",
        locationName: "VPS",
        available: true,
        remoteEndpointId: "endpoint-vps"
      }),
      expect.objectContaining({
        id: "remote:endpoint-other",
        available: false,
        unavailableReason: "agent_endpoint_incompatible"
      })
    ]);
  });

  it("keeps Server availability failures visible and disabled", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-offline",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "unavailable",
          unavailableReason: "host_offline",
          capabilities: ["acp.codex"]
        }
      ]
    });
    expect(endpoints[0]).toMatchObject({
      available: false,
      unavailableReason: "host_offline"
    });
  });

  it("omits permanently dead Hosts from the executor picker", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-revoked",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "unavailable",
          unavailableReason: "host_revoked",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-expired",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "unavailable",
          unavailableReason: "host_credential_expired",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-offline",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "unavailable",
          unavailableReason: "host_offline",
          capabilities: ["acp.codex"]
        }
      ]
    });
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual(["remote:endpoint-offline"]);
  });

  it("keeps capability-incompatible Endpoints visible and disabled", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex", "network"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-without-network",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints[0]).toMatchObject({
      id: "remote:endpoint-without-network",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it("applies required capabilities to local Endpoints too", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [
        {
          executorName: "codex-acp",
          displayName: "Codex",
          locationName: "This device",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null
        }
      ],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex", "linux"],
      remote: []
    });

    expect(endpoints[0]).toMatchObject({
      id: "local:codex-acp",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });
});
