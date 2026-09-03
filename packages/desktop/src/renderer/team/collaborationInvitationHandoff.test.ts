import { describe, expect, it } from "vitest";
import { serializeCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import {
  collaborationInvitationHandoffV1Prefix,
  collaborationInvitationHandoffV2Prefix,
  endpointForLegacyCollaborationInvitationHandoff,
  parseCollaborationInvitationHandoff,
  serializeCollaborationInvitationHandoff
} from "./collaborationInvitationHandoff";
import { parseCollaborationJoinPaste } from "./collaborationJoinPaste";

const invitationToken = `pw_inv_${"A".repeat(43)}`;

describe("collaboration invitation handoff", () => {
  it("serializes a locale-independent V2 payload with a validated endpoint", () => {
    expect(
      serializeCollaborationInvitationHandoff({
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://collaboration.example.test/",
          allowedClientOrigins: ["https://collaboration.example.test/"],
          tlsTrust: "system_ca"
        },
        projectId: "project-1",
        invitationToken
      })
    ).toBe(
      `${collaborationInvitationHandoffV2Prefix}{"endpoint":{"topology":"public_https","serverOrigin":"https://collaboration.example.test/","allowedClientOrigins":["https://collaboration.example.test/"],"tlsTrust":"system_ca"},"projectId":"project-1","invitationToken":"${invitationToken}"}`
    );
  });

  it("normalizes a V2 endpoint for the existing connection profile", () => {
    const serialized = serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:56584/",
        allowedClientOrigins: ["http://192.168.1.20:56584/"],
        tlsTrust: "not_applicable"
      },
      projectId: "project-1",
      invitationToken
    });

    expect(parseCollaborationInvitationHandoff(serialized)).toEqual({
      serverBaseUrl: "http://192.168.1.20:56584/",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true,
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:56584/",
        allowedClientOrigins: ["http://192.168.1.20:56584/"],
        tlsTrust: "not_applicable"
      }
    });
  });

  it.each([
    ["loopback_https", "https://127.0.0.1:7443/", "configured_ca"],
    ["private_https", "https://192.168.1.20:7443/", "configured_ca"],
    ["public_https", "https://server.example.test/", "system_ca"],
    ["private_https", "https://planweave.example.ts.net/", "system_ca"]
  ] as const)("preserves %s endpoint authority through V2 join parsing", (topology, origin, tlsTrust) => {
    const endpoint = {
      topology,
      serverOrigin: origin,
      allowedClientOrigins: [origin],
      tlsTrust
    };
    const serialized = serializeCollaborationInvitationHandoff({
      endpoint,
      projectId: "project-1",
      invitationToken
    });
    expect(parseCollaborationInvitationHandoff(serialized)?.endpoint).toEqual(endpoint);
  });

  it("does not reinterpret a custom public .ts.net endpoint as Tailscale", () => {
    const endpoint = {
      topology: "public_https" as const,
      serverOrigin: "https://custom.example.ts.net/",
      allowedClientOrigins: ["https://custom.example.ts.net/"],
      tlsTrust: "configured_ca" as const
    };
    expect(
      parseCollaborationInvitationHandoff(
        serializeCollaborationInvitationHandoff({
          endpoint,
          projectId: "project-1",
          invitationToken
        })
      )?.endpoint
    ).toEqual(endpoint);
  });

  it("rejects a legacy URL and invitation token when the project ID is absent", () => {
    expect(
      parseCollaborationInvitationHandoff(
        `Join at https://collaboration.example.test with token ${invitationToken}`
      )
    ).toBeNull();
  });

  it("preserves a project ID when the legacy copied text supplies one", () => {
    expect(
      parseCollaborationInvitationHandoff(
        `Server URL: http://192.168.1.20:56584\nProject ID: project-1\nInvitation token: ${invitationToken}`
      )
    ).toEqual({
      serverBaseUrl: "http://192.168.1.20:56584",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true
    });
  });

  it("accepts the established Chinese legacy project label", () => {
    expect(
      parseCollaborationInvitationHandoff(
        `服务器 URL: https://collaboration.example.test\n项目 ID: project-1\n邀请令牌: ${invitationToken}`
      )
    ).toMatchObject({ projectId: "project-1", invitationToken });
  });

  it("adapts only explicit private HTTP legacy invitations to an endpoint", () => {
    const legacyHttp = parseCollaborationInvitationHandoff(
      `Server: http://192.168.1.20:8787/\nProject ID: project-1\nToken: ${invitationToken}`
    );
    expect(legacyHttp && endpointForLegacyCollaborationInvitationHandoff(legacyHttp)).toMatchObject(
      {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:8787/"
      }
    );
    const legacyHttps = parseCollaborationInvitationHandoff(
      `Server: https://custom.example.ts.net/\nProject ID: project-1\nToken: ${invitationToken}`
    );
    expect(legacyHttps && endpointForLegacyCollaborationInvitationHandoff(legacyHttps)).toBeNull();
  });

  it("rejects malformed or unsafe handoff payloads", () => {
    expect(parseCollaborationInvitationHandoff("not an invitation")).toBeNull();
    expect(
      parseCollaborationInvitationHandoff(
        `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"https://collaboration.example.test","projectId":"project-1"}`
      )
    ).toBeNull();
    expect(
      parseCollaborationInvitationHandoff(
        `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"http://example.com","projectId":"project-1","invitationToken":"${invitationToken}","allowInsecureTransport":true}`
      )
    ).toBeNull();
  });
});

describe("collaboration join paste", () => {
  it("redeems a Mac member-device setup envelope pasted into Join Workspace", () => {
    const setupCode = `pw_setup_${"A".repeat(43)}`;
    const handoff = serializeCollaborationSetupHandoffV1({
      serverBaseUrl: "https://vm-0-3-ubuntu.tailb06a1e.ts.net/",
      setupCode,
      allowInsecureTransport: false
    });

    expect(parseCollaborationJoinPaste(`\uFEFF${handoff}\r\n`)).toEqual({
      kind: "setup",
      handoff: {
        serverBaseUrl: "https://vm-0-3-ubuntu.tailb06a1e.ts.net/",
        setupCode,
        allowInsecureTransport: false
      }
    });
  });

  it("does not treat a malformed setup envelope as a project invitation", () => {
    expect(
      parseCollaborationJoinPaste(`\uFEFFplanweave-server-setup/v1:{"serverBaseUrl":"not-a-url"}`)
    ).toEqual({ kind: "invalid_setup" });
  });
});
