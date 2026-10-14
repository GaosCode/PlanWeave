import { createServer } from "node:http";
import { z } from "zod";
import {
  CommentAttachmentBlobStore,
  CommentAttachmentRepository,
  CommentAttachmentService,
  handleCommentAttachmentHttpRequest
} from "../../attachments/index.js";
import { CommentAttachmentDigestLifecycle } from "../../attachments/digestLifecycle.js";
import { HumanIdentityRepository, WorkspaceIdentityRepository } from "../../identity/index.js";
import { openServerDatabase } from "../../sqlite.js";
import { loopbackHttpTransportAdmission } from "./transportAdmission.js";
import { join } from "node:path";

const input = z
  .object({
    directory: z.string(),
    now: z.string().datetime(),
    mode: z.enum(["normal", "hold-gc", "hold-gc-entry", "hold-publish"])
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const database = await openServerDatabase(join(input.directory, "server.sqlite"), 5000);
const clock = () => new Date(input.now);
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let paused = false;
class ProcessBlobStore extends CommentAttachmentBlobStore {
  override async deleteIfUnreferenced(digest: string, nowIso: string): Promise<boolean> {
    if (input.mode === "hold-gc" && !paused) {
      paused = true;
      process.send?.({ event: "gc-held", digest });
      await gate;
    }
    return super.deleteIfUnreferenced(digest, nowIso);
  }
  override async stage(
    body: Parameters<CommentAttachmentBlobStore["stage"]>[0]
  ): ReturnType<CommentAttachmentBlobStore["stage"]> {
    const staged = await super.stage(body);
    return {
      ...staged,
      publish: async () => {
        const metadata = await staged.publish();
        if (input.mode === "hold-publish" && !paused) {
          paused = true;
          process.send?.({ event: "publish-held", digest: metadata.digestSha256 });
          await gate;
        }
        return metadata;
      }
    };
  }
}
const identity = new HumanIdentityRepository(database, clock);
const workspaceIdentity = new WorkspaceIdentityRepository(database);
const scopes = ["project-a", "project-b"].map((projectId) => ({
  projectId,
  workspaceId: workspaceIdentity.ensureWorkspaceForLegacyProject(projectId)
}));
const repository = new CommentAttachmentRepository(database);
class ProcessLifecycle extends CommentAttachmentDigestLifecycle {
  override async withDigest<T>(digest: string, action: () => Promise<T>): Promise<T> {
    if (input.mode === "hold-gc-entry" && !paused) {
      paused = true;
      process.send?.({ event: "gc-entry-held", digest });
      await gate;
    }
    return super.withDigest(digest, action);
  }
}
const service = new CommentAttachmentService({
  repository,
  blobs: new ProcessBlobStore(database, input.directory),
  lifecycle: new ProcessLifecycle(database, input.directory),
  identity,
  canRead({ actor, workspaceId }) {
    return workspaceIdentity.hasActiveMembership(workspaceId, actor.humanPrincipalId);
  },
  clock
});
const server = createServer((request, response) => {
  void handleCommentAttachmentHttpRequest(request, response, {
    service,
    repository: identity,
    workspaceIdentity,
    collaborationScopeAuthority: {
      hasProject: (projectId) => scopes.some((scope) => scope.projectId === projectId),
      hasScope: (input) =>
        scopes.some(
          (scope) => scope.projectId === input.projectId && scope.workspaceId === input.workspaceId
        )
    },
    transportAdmission: loopbackHttpTransportAdmission,
    clock
  })
    .then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    })
    .catch((error: unknown) => {
      process.send?.({
        event: "request-error",
        message: error instanceof Error ? error.message : String(error)
      });
      if (!response.headersSent) {
        response.writeHead(500);
        response.end(JSON.stringify({ error: "request_failed" }));
      } else response.destroy();
    });
});
process.on("message", (message: unknown) => {
  const command = z
    .discriminatedUnion("command", [
      z.object({ command: z.enum(["release", "stop"]) }),
      z.object({ command: z.literal("bind"), pendingUploadId: z.string() })
    ])
    .parse(message);
  if (command.command === "bind") {
    try {
      const workspaceId = scopes[0]!.workspaceId;
      const record = repository.getPendingRequired(
        workspaceId,
        "project-a",
        command.pendingUploadId
      );
      repository.bindCommentAttachments({
        workspaceId,
        projectId: "project-a",
        commentId: "process-comment",
        attachments: [
          {
            pendingUploadId: record.pendingUploadId,
            digestSha256: record.digestSha256!,
            sizeBytes: record.expectedSizeBytes,
            mediaType: record.mediaType,
            createdAt: clock().toISOString()
          }
        ],
        createdAt: clock().toISOString()
      });
      process.send?.({ event: "bound" });
    } catch (error) {
      process.send?.({
        event: "bind-denied",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }
  release();
  if (command.command === "stop") {
    server.close(() => {
      database.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("child_http_address_missing");
process.send?.({
  event: "ready",
  origin: `http://127.0.0.1:${address.port}`,
  processId: process.pid
});
