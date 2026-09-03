import { describe, expect, it } from "vitest";
import {
  collaborationSetupHandoffV1Prefix,
  collaborationSetupHandoffV1Schema,
  parseCollaborationSetupHandoffV1,
  serializeCollaborationSetupHandoffV1
} from "../setupHandoff.js";

const setupCode = `pw_setup_${"A".repeat(43)}`;

describe("collaboration setup handoff contract", () => {
  it("serializes and parses the stable V1 envelope", () => {
    const handoff = {
      serverBaseUrl: "http://192.168.1.20:56584/",
      setupCode,
      allowInsecureTransport: true
    };

    expect(serializeCollaborationSetupHandoffV1(handoff)).toBe(
      `${collaborationSetupHandoffV1Prefix}{"serverBaseUrl":"http://192.168.1.20:56584/","setupCode":"${setupCode}","allowInsecureTransport":true}`
    );
    expect(parseCollaborationSetupHandoffV1(serializeCollaborationSetupHandoffV1(handoff))).toEqual(
      handoff
    );
  });

  it("rejects invalid secrets and unsafe public HTTP origins", () => {
    expect(
      collaborationSetupHandoffV1Schema.safeParse({
        serverBaseUrl: "http://example.com/",
        setupCode,
        allowInsecureTransport: true
      }).success
    ).toBe(false);
    expect(
      parseCollaborationSetupHandoffV1(
        `${collaborationSetupHandoffV1Prefix}{"serverBaseUrl":"https://collaboration.example.test/","setupCode":"invalid","allowInsecureTransport":false}`
      )
    ).toBeNull();
  });

  it("parses a clipboard paste that includes a BOM and Windows newlines", () => {
    const handoff = serializeCollaborationSetupHandoffV1({
      serverBaseUrl: "https://collaboration.example.test/",
      setupCode,
      allowInsecureTransport: false
    });
    expect(parseCollaborationSetupHandoffV1(`\uFEFF${handoff}\r\n`)).toEqual({
      serverBaseUrl: "https://collaboration.example.test/",
      setupCode,
      allowInsecureTransport: false
    });
  });
});
