import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  exampleExecuteDelivery,
  exampleExecuteDeliveryV1
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { HttpArtifactClient } from "../artifacts/httpArtifactTransfer.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function listen(
  handler: Parameters<typeof createServer>[0]
): Promise<{ client: HttpArtifactClient; origin: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_artifact_test_port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    client: new HttpArtifactClient({
      baseUrl: new URL(origin),
      hostId: "host-artifact-test",
      token: "host-token"
    })
  };
}

function command(runtimeAuthority: "owner_canvas" | "workspace_canvas" = "workspace_canvas") {
  return {
    ...exampleExecuteDelivery.command,
    leaseId: "lease-artifact-test",
    leaseExpiresAt: "2030-01-01T00:00:00.000Z",
    envelope: {
      ...exampleExecuteDelivery.command.envelope,
      runtimeAuthority
    }
  };
}

describe("HttpArtifactClient", () => {
  it("preserves historical v1 Workspace artifact scoping", async () => {
    const bytes = Buffer.from("legacy input", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let requestUrl: string | undefined;
    const { client } = await listen((request, response) => {
      requestUrl = request.url;
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
    });
    const legacyCommand = {
      ...exampleExecuteDeliveryV1.command,
      leaseId: "lease-artifact-v1"
    };
    if (legacyCommand.type !== "execute_block") throw new Error("execute_command_expected");

    await expect(
      client
        .forExecution(legacyCommand, () => undefined, new AbortController().signal)
        .download({
          artifactRef: `artifact:sha256:${sha256}`,
          logicalName: "legacy-input",
          mediaType: "text/plain"
        })
    ).resolves.toEqual({ bytes, mediaType: "text/plain" });
    expect(new URL(requestUrl ?? "", "http://planweave.test").searchParams.get("workspaceId")).toBe(
      exampleExecuteDeliveryV1.command.envelope.workspaceId
    );
  });

  it("downloads a scoped input, verifies metadata and digest, then records evidence", async () => {
    const bytes = Buffer.from("verified input", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const seen: { authorization?: string; url?: string } = {};
    const { client } = await listen((request, response) => {
      seen.authorization = request.headers.authorization;
      seen.url = request.url;
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
    });
    const evidence: unknown[] = [];
    const transfer = client.forExecution(
      command(),
      (record) => evidence.push(record),
      new AbortController().signal
    );

    await expect(
      transfer.download({
        artifactRef: `artifact:sha256:${sha256}`,
        logicalName: "requirements",
        mediaType: "text/plain"
      })
    ).resolves.toEqual({ bytes, mediaType: "text/plain" });
    expect(seen.authorization).toBe("Bearer host-token");
    expect(seen.url).toContain(`/artifacts/${sha256}`);
    expect(new URL(seen.url ?? "", "http://planweave.test").searchParams.get("workspaceId")).toBe(
      exampleExecuteDelivery.command.envelope.workspaceId
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        direction: "input",
        artifactRef: `artifact:sha256:${sha256}`,
        sha256,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain"
      })
    ]);
  });

  it("does not couple owner Canvas artifact transfer to a Host Workspace scope", async () => {
    const bytes = Buffer.from("owner canvas input", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let requestUrl: string | undefined;
    const { client } = await listen((request, response) => {
      requestUrl = request.url;
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
    });
    const transfer = client.forExecution(
      command("owner_canvas"),
      () => undefined,
      new AbortController().signal
    );

    await expect(
      transfer.download({
        artifactRef: `artifact:sha256:${sha256}`,
        logicalName: "owner-input",
        mediaType: "text/plain"
      })
    ).resolves.toEqual({ bytes, mediaType: "text/plain" });
    expect(new URL(requestUrl ?? "", "http://planweave.test").searchParams.has("workspaceId")).toBe(
      false
    );
  });

  it("rejects input hash, size, and media-type mismatches without recording evidence", async () => {
    const bytes = Buffer.from("abc", "utf8");
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    let mode: "hash" | "size" | "media" = "hash";
    const { client } = await listen((_request, response) => {
      response.writeHead(200, {
        "content-type": mode === "media" ? "application/json" : "text/plain",
        "content-length": mode === "size" ? 65 * 1_024 * 1_024 : bytes.byteLength
      });
      response.end(bytes);
    });
    const evidence: unknown[] = [];
    const transfer = client.forExecution(
      command(),
      (record) => evidence.push(record),
      new AbortController().signal
    );

    await expect(
      transfer.download({
        artifactRef: `artifact:sha256:${"0".repeat(64)}`,
        logicalName: "hash"
      })
    ).rejects.toThrow("artifact_download_hash_mismatch");
    mode = "size";
    await expect(
      transfer.download({
        artifactRef: `artifact:sha256:${actualSha256}`,
        logicalName: "size"
      })
    ).rejects.toThrow("artifact_download_size_invalid");
    mode = "media";
    await expect(
      transfer.download({
        artifactRef: `artifact:sha256:${actualSha256}`,
        logicalName: "media",
        mediaType: "text/plain"
      })
    ).rejects.toThrow("artifact_download_media_type_mismatch");
    expect(evidence).toEqual([]);
  });

  it("records an upload only after the server returns the matching content address", async () => {
    const bodies: Buffer[] = [];
    let returnMismatch = false;
    const { client } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        bodies.push(body);
        const sha256 = createHash("sha256").update(body).digest("hex");
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ref: `artifact:sha256:${returnMismatch ? "0".repeat(64) : sha256}`
          })
        );
      });
    });
    const evidence: unknown[] = [];
    const transfer = client.forExecution(
      command(),
      (record) => evidence.push(record),
      new AbortController().signal
    );
    const bytes = Buffer.from("report", "utf8");

    await expect(
      transfer.upload({
        bytes,
        mediaType: "text/markdown",
        purpose: "report",
        operationKey: "report"
      })
    ).resolves.toBe(`artifact:sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(evidence).toHaveLength(1);
    returnMismatch = true;
    await expect(
      transfer.upload({
        bytes: Buffer.from("other", "utf8"),
        mediaType: "text/markdown",
        purpose: "report",
        operationKey: "other"
      })
    ).rejects.toThrow("artifact_upload_ref_mismatch");
    expect(evidence).toHaveLength(1);
    expect(bodies).toHaveLength(2);
  });
});
