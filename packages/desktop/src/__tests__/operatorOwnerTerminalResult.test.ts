import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
  OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER,
  operatorOwnerTerminalResultMetadataSchema
} from "@planweave-ai/agent-host-protocol";
import { exampleHumanIdentityToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { describe, expect, it, vi } from "vitest";
import {
  OperatorControlClient,
  type OperatorCredentialPort
} from "../main/operatorControl/OperatorControlClient.js";

const operatorToken = "operator_terminal_result_abcdefghijklmnopqrstuvwxyz_1234";
const humanPrincipalId = "human-owner-1";
const metadata = operatorOwnerTerminalResultMetadataSchema.parse({
  operationId: "operation-owner-1",
  projectId: "project-owner-1",
  canvasId: "canvas-owner-1",
  blockRef: "T-001#B-001",
  controlPlane: "owner",
  sourceRevision: "source-revision-1",
  graphFingerprint: `pkg-${"a".repeat(64)}`,
  dispatchId: "dispatch-owner-1",
  executionAttemptId: "attempt-owner-1",
  reportArtifactRef: `artifact:sha256:${"b".repeat(64)}`
});

function client(input: { request: typeof fetch; credential?: OperatorCredentialPort }) {
  return new OperatorControlClient({
    profile: {
      profileId: "profile-owner-1",
      displayName: "Owner Server",
      serverBaseUrl: "https://operator.example.test/",
      allowInsecureTransport: false
    },
    credential: input.credential ?? {
      getOperatorToken: () => operatorToken,
      getHumanIdentityToken: () => exampleHumanIdentityToken
    },
    request: input.request
  });
}

describe("Owner terminal result transport", () => {
  it("reads a report larger than the bounded Operator JSON response", async () => {
    const reportBytes = Buffer.alloc(70 * 1024, 0x61);
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-planweave-human-identity")).toBe(
        `Bearer ${exampleHumanIdentityToken}`
      );
      return new Response(reportBytes, {
        status: 200,
        headers: {
          "content-type": OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
          "content-length": String(reportBytes.byteLength),
          [OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER]: Buffer.from(
            JSON.stringify(metadata),
            "utf8"
          ).toString("base64url")
        }
      });
    }) as typeof fetch;

    await expect(
      client({ request }).readOwnerRemoteOperationTerminalResult(
        metadata.operationId,
        humanPrincipalId
      )
    ).resolves.toEqual({ metadata, reportBytes });
  });

  it("fails before transport when Human identity proof is unavailable", async () => {
    const request = vi.fn() as unknown as typeof fetch;

    await expect(
      client({
        request,
        credential: { getOperatorToken: () => operatorToken }
      }).readOwnerRemoteOperationTerminalResult(metadata.operationId, humanPrincipalId)
    ).rejects.toMatchObject({
      kind: "unauthorized",
      code: "operator_human_identity_credential_missing"
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a declared report larger than the artifact limit", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: {
            "content-type": OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
            "content-length": String(OUTPUT_MAX_ARTIFACT_BYTES + 1),
            [OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER]: Buffer.from(
              JSON.stringify(metadata),
              "utf8"
            ).toString("base64url")
          }
        })
    ) as typeof fetch;

    await expect(
      client({ request }).readOwnerRemoteOperationTerminalResult(
        metadata.operationId,
        humanPrincipalId
      )
    ).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "operator_terminal_result_too_large"
    });
  });
});
