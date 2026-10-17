import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { parseServerConfig } from "../../config.js";
import { hashOperatorToken } from "../../operatorAuth.js";
import { ProjectRegistryRepository } from "../../projectRegistryRepository.js";
import { createDistributedServerComposition } from "../../serverComposition.js";
import { WebSocketUpgradeRouter } from "../../webSocketUpgradeRouter.js";

const input = z
  .object({ root: z.string(), projectId: z.string() })
  .parse(JSON.parse(process.argv[2]!));
const server = createServer();
let router: WebSocketUpgradeRouter | undefined;
const register = WebSocketUpgradeRouter.prototype.register;
WebSocketUpgradeRouter.prototype.register = function (handler) {
  router = this;
  return register.call(this, handler);
};
const composition = await createDistributedServerComposition({
  httpServer: server,
  config: parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(input.root, "server-data"),
    operatorCredentials: [
      {
        operatorId: "upgrade-admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"U".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ],
    trustedProjects: [
      {
        workspaceId: "upgrade-workspace",
        projectId: input.projectId,
        canvasId: "default",
        projectRoot: input.root
      }
    ]
  })
});
WebSocketUpgradeRouter.prototype.register = register;
assert(router, "composition_upgrade_router_required");

const secret = "upgrade-handler-secret";
const fault = () => new Error(`${secret} ${input.root}`);
const hasActiveScope = ProjectRegistryRepository.prototype.hasActiveScope;
ProjectRegistryRepository.prototype.hasActiveScope = function (scope) {
  if (scope.canvasId === "auth-fault") throw fault();
  return hasActiveScope.call(this, scope);
};

let rejectPending: ((error: Error) => void) | undefined;
const extraWebSockets = new WebSocketServer({ noServer: true });
const unregister = router.register({
  matches(request) {
    if (request.url === "/__upgrade_fault/matches") throw fault();
    return request.url?.startsWith("/__upgrade_fault/") ?? false;
  },
  handle(request, socket, head, upgrade) {
    if (request.url === "/__upgrade_fault/sync") throw fault();
    if (request.url === "/__upgrade_fault/async") {
      const pending = new Promise<void>((_resolve, reject) => {
        rejectPending = reject;
      });
      // The parent cannot release this rejection until the upgrade listener has returned.
      setImmediate(() => process.send?.({ event: "handler-pending" }));
      return pending;
    }
    if (!upgrade.handoff()) return;
    extraWebSockets.handleUpgrade(request, socket, head, () => {
      throw fault();
    });
  }
});

const commandSchema = z.object({ command: z.enum(["reject", "stop", "checkpoint"]) });
process.on("message", (message: unknown) => {
  const { command } = commandSchema.parse(message);
  if (command === "reject") {
    assert(rejectPending, "pending_handler_required");
    rejectPending(fault());
    rejectPending = undefined;
  } else if (command === "checkpoint") {
    process.stderr.write("", () => process.send?.({ event: "checkpoint" }));
  } else {
    void (async () => {
      unregister();
      for (const socket of extraWebSockets.clients) socket.terminate();
      await new Promise<void>((resolve) => extraWebSockets.close(() => resolve()));
      await composition.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.disconnect?.();
    })();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string", "child_http_address_required");
process.send?.({ event: "ready", origin: `http://127.0.0.1:${address.port}` });
