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
    mode: z.enum(["normal", "hold-gc", "hold-publish"])
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
  override async deleteIfUnreferenced(digest: string): Promise<boolean> {
    if (input.mode === "hold-gc" && !paused) {
      paused = true;
      process.send?.({ event: "gc-held", digest });
      await gate;
    }
    return super.deleteIfUnreferenced(digest);
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
const service = new CommentAttachmentService({
  repository: new CommentAttachmentRepository(database),
  blobs: new ProcessBlobStore(database, input.directory),
  lifecycle: new CommentAttachmentDigestLifecycle(database, input.directory),
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
  const command = z.object({ command: z.enum(["release", "stop"]) }).parse(message);
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
