import { describe, expect, it } from "vitest";
import {
  collaborationInvitationHandoffV1Prefix,
  collaborationInvitationHandoffV1Schema,
  collaborationInvitationHandoffResponseSchema,
  collaborationInvitationHandoffV2Prefix,
  parseCollaborationInvitationHandoff,
  parseCollaborationInvitationHandoffV1,
  serializeCollaborationInvitationHandoffV1,
  serializeCollaborationInvitationHandoffV2
} from "../invitationHandoff.js";

const invitationToken = `pw_inv_${"A".repeat(43)}`;

describe("collaboration invitation handoff contract", () => {
  it("serializes new handoffs as V2 with the validated advertised endpoint", () => {
    const handoff = {
      endpoint: {
        topology: "private_https" as const,
        serverOrigin: "https://planweave.example.ts.net/",
        allowedClientOrigins: ["https://planweave.example.ts.net/"],
        tlsTrust: "system_ca" as const
      },
      projectId: "project-1",
      invitationToken
    };
    const serialized = serializeCollaborationInvitationHandoffV2(handoff);
    expect(serialized.startsWith(collaborationInvitationHandoffV2Prefix)).toBe(true);
    expect(parseCollaborationInvitationHandoff(serialized)).toEqual(handoff);
  });

  it("serializes and parses the stable V1 envelope", () => {
    const handoff = {
      serverBaseUrl: "http://192.168.1.20:56584/",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true
    };

    expect(serializeCollaborationInvitationHandoffV1(handoff)).toBe(
      `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"http://192.168.1.20:56584/","projectId":"project-1","invitationToken":"${invitationToken}","allowInsecureTransport":true}`
    );
    expect(
      parseCollaborationInvitationHandoffV1(serializeCollaborationInvitationHandoffV1(handoff))
    ).toEqual(handoff);
  });

  it("reuses the project, invitation-token, origin, and transport policy validators", () => {
    expect(
      collaborationInvitationHandoffV1Schema.safeParse({
        serverBaseUrl: "http://example.com/",
        projectId: "project-1",
        invitationToken,
        allowInsecureTransport: true
      }).success
    ).toBe(false);
    expect(
      parseCollaborationInvitationHandoffV1(
        `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"https://collaboration.example.test/","projectId":"project-1","invitationToken":"invalid","allowInsecureTransport":false}`
      )
    ).toBeNull();
  });

  it("rejects invalid V2 endpoints while retaining V1 parsing compatibility", () => {
    expect(
      parseCollaborationInvitationHandoff(
        `${collaborationInvitationHandoffV2Prefix}{"endpoint":{"topology":"private_https","serverOrigin":"http://example.test/","allowedClientOrigins":["http://example.test/"],"tlsTrust":"not_applicable"},"projectId":"project-1","invitationToken":"${invitationToken}"}`
      )
    ).toBeNull();

    const legacy = serializeCollaborationInvitationHandoffV1({
      serverBaseUrl: "http://192.168.1.20:56584/",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true
    });
    expect(parseCollaborationInvitationHandoff(legacy)).toMatchObject({
      serverBaseUrl: "http://192.168.1.20:56584/"
    });
  });

  it("accepts only a matching V2 envelope in invitation responses", () => {
    const invitation = {
      invitationId: "invitation-1",
      projectId: "project-1",
      role: "member" as const,
      createdByHumanPrincipalId: "human-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z"
    };
    const handoff = serializeCollaborationInvitationHandoffV2({
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example.test/",
        allowedClientOrigins: ["https://server.example.test/"],
        tlsTrust: "system_ca"
      },
      projectId: "project-1",
      invitationToken
    });
    expect(
      collaborationInvitationHandoffResponseSchema.safeParse({
        invitation,
        invitationToken,
        handoff
      }).success
    ).toBe(true);
    expect(
      collaborationInvitationHandoffResponseSchema.safeParse({
        invitation,
        invitationToken,
        handoff: serializeCollaborationInvitationHandoffV1({
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          invitationToken,
          allowInsecureTransport: true
        })
      }).success
    ).toBe(false);
    expect(
      collaborationInvitationHandoffResponseSchema.safeParse({
        invitation,
        invitationToken,
        handoff: serializeCollaborationInvitationHandoffV2({
          endpoint: {
            topology: "public_https",
            serverOrigin: "https://server.example.test/",
            allowedClientOrigins: ["https://server.example.test/"],
            tlsTrust: "system_ca"
          },
          projectId: "project-other",
          invitationToken
        })
      }).success
    ).toBe(false);
  });

  it("parses a clipboard paste that includes a BOM and Windows newlines", () => {
    const serialized = serializeCollaborationInvitationHandoffV2({
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example.test/",
        allowedClientOrigins: ["https://server.example.test/"],
        tlsTrust: "system_ca"
      },
      projectId: "project-1",
      invitationToken
    });
    expect(parseCollaborationInvitationHandoff(`\uFEFF${serialized}\r\n`)).toEqual({
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example.test/",
        allowedClientOrigins: ["https://server.example.test/"],
        tlsTrust: "system_ca"
      },
      projectId: "project-1",
      invitationToken
    });
  });
});
