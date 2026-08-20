import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CanvasRuntimeArtifactTransfer } from "../artifacts/canvasRuntimeArtifactTransfer.js";

const bytes = Buffer.from("runtime artifact\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const base = {
  version: "canvas-runtime-artifact-transfer/v1" as const,
  grantId: "runtime-artifact-grant-a",
  runtimeLeaseId: "runtime-lease-a",
  artifactRef: `artifact:sha256:${sha256}`,
  sha256,
  mediaType: "text/plain",
  expiresAt: "2099-01-01T00:00:00.000Z"
};

describe("CanvasRuntimeArtifactTransfer", () => {
  it("downloads through the logical lease route and verifies all declared evidence", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        `https://server.example/agent-hosts/host-a/canvas-runtime/leases/runtime-lease-a/artifacts/${sha256}`
      );
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer token-a",
        "x-planweave-runtime-artifact-grant-id": base.grantId
      });
      return new Response(bytes, {
        headers: { "content-type": "text/plain", "content-length": String(bytes.byteLength) }
      });
    });
    const transfer = new CanvasRuntimeArtifactTransfer({
      baseUrl: new URL("https://server.example"),
      hostId: "host-a",
      token: "token-a",
      request
    });
    await expect(
      transfer.download(
        { ...base, direction: "download", sizeBytes: bytes.byteLength },
        new AbortController().signal
      )
    ).resolves.toEqual(new Uint8Array(bytes));
  });

  it("rejects download digest, size, and media mismatches", async () => {
    for (const response of [
      new Response(Buffer.from("wrong"), {
        headers: { "content-type": "text/plain", "content-length": "5" }
      }),
      new Response(bytes, {
        headers: { "content-type": "text/plain", "content-length": "1" }
      }),
      new Response(bytes, {
        headers: {
          "content-type": "application/json",
          "content-length": String(bytes.byteLength)
        }
      })
    ]) {
      const transfer = new CanvasRuntimeArtifactTransfer({
        baseUrl: new URL("https://server.example"),
        hostId: "host-a",
        token: "token-a",
        request: vi.fn(async () => response)
      });
      await expect(
        transfer.download(
          { ...base, direction: "download", sizeBytes: bytes.byteLength },
          new AbortController().signal
        )
      ).rejects.toThrow();
    }
  });

  it("uploads only bytes matching the pre-authorized ref and media type", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("PUT");
      expect(init?.headers).toMatchObject({
        "content-type": "text/plain",
        "content-length": String(bytes.byteLength)
      });
      return Response.json({
        artifactRef: base.artifactRef,
        sha256,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain"
      });
    });
    const transfer = new CanvasRuntimeArtifactTransfer({
      baseUrl: new URL("https://server.example"),
      hostId: "host-a",
      token: "token-a",
      request
    });
    const descriptor = { ...base, direction: "upload" as const, maxSizeBytes: 1024 };
    await expect(
      transfer.upload(descriptor, bytes, "text/plain", new AbortController().signal)
    ).resolves.toBeUndefined();
    await expect(
      transfer.upload(descriptor, Buffer.from("wrong"), "text/plain", new AbortController().signal)
    ).rejects.toThrow("runtime_artifact_digest_mismatch");
    expect(request).toHaveBeenCalledOnce();
  });

  it("uses rotated credentials for subsequent transfers", async () => {
    const request = vi.fn<typeof fetch>(async (_input, _init) => {
      return Response.json({
        artifactRef: base.artifactRef,
        sha256,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain"
      });
    });
    const transfer = new CanvasRuntimeArtifactTransfer({
      baseUrl: new URL("https://server.example"),
      hostId: "host-a",
      token: "token-a",
      request
    });
    transfer.updateCredentialToken("token-b");
    await transfer.upload(
      { ...base, direction: "upload", maxSizeBytes: 1024 },
      bytes,
      "text/plain",
      new AbortController().signal
    );
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer token-b" });
  });

  it("evaluates grant expiry with the synchronized server clock", async () => {
    const transfer = new CanvasRuntimeArtifactTransfer({
      baseUrl: new URL("https://server.example"),
      hostId: "host-a",
      token: "token-a",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      request: vi.fn()
    });
    transfer.synchronizeServerTime(
      "2026-01-01T00:10:00.000Z",
      new Date("2026-01-01T00:00:00.000Z")
    );
    await expect(
      transfer.download(
        {
          ...base,
          expiresAt: "2026-01-01T00:05:00.000Z",
          direction: "download",
          sizeBytes: bytes.byteLength
        },
        new AbortController().signal
      )
    ).rejects.toThrow("runtime_artifact_grant_expired");
  });
});
