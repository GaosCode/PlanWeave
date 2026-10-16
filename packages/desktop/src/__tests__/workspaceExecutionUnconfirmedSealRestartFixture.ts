import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { z } from "zod";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { desktopWorkspaceExecutionStartCancellationInputSchema } from "../shared/workspaceExecution.js";

const config = z
  .object({
    mode: z.enum(["seal", "recover"]),
    root: z.string(),
    sessionsRoot: z.string(),
    stop: desktopWorkspaceExecutionStartCancellationInputSchema
  })
  .strict()
  .parse(JSON.parse(process.argv[2]));

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error("restart_fixture_ipc_required"));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

process.on("message", (raw) => {
  const command = z
    .object({ kind: z.literal("exit"), code: z.number().int() })
    .strict()
    .parse(raw);
  process.exit(command.code);
});

async function run() {
  const requests: { path: string; method: string }[] = [];
  if (config.mode === "seal") {
    const rename = fs.rename;
    mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      const [source, target] = args;
      await rename(source, target);
      if (String(target).startsWith(join(config.sessionsRoot, "start-intents"))) {
        const sealed = z
          .object({
            settled: z.boolean(),
            cancellationConfirmed: z.boolean(),
            cancellation: desktopWorkspaceExecutionStartCancellationInputSchema.nullable()
          })
          .parse(JSON.parse(await fs.readFile(target, "utf8")));
        if (
          sealed.settled === true &&
          sealed.cancellationConfirmed === false &&
          sealed.cancellation?.startRequestId === config.stop.startRequestId
        ) {
          // The real atomic rename finished; cancelStart cannot reach its confirmation write.
          await send({ kind: "sealed", pid: process.pid, requests });
          await new Promise<void>(() => {});
        }
      }
    });
    syncBuiltinESMExports();
  }

  const { WorkspaceExecutionDesktopService } = await import(
    "../main/workspaceExecutionDesktopService.js"
  );
  const collaboration = new CollaborationService({
    profileStorePaths: { profilesPath: join(config.root, "profiles.json") },
    workspaceProfileStorePaths: { profilesPath: join(config.root, "workspaces.json") },
    credentialsPath: join(config.root, "credentials.json"),
    invitationsPath: join(config.root, "invitations.json"),
    exportedIdentityPath: join(config.root, "exported.json"),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString()
    },
    request: async (input, init) => {
      requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
      return fetch(input, init);
    }
  });
  const service = new WorkspaceExecutionDesktopService(
    collaboration,
    {
      withExecutionProfile: async () => {
        throw new Error("unexpected_owner_canvas");
      }
    },
    config.sessionsRoot
  );
  try {
    if (config.mode === "seal") {
      await service.cancelStart(config.stop);
      throw new Error("seal_barrier_not_reached");
    }

    const input = config.stop.input;
    const before = await service.recoverCancellations({ locator: input.locator });
    const confirmation = await service.cancelStart(config.stop);
    const after = await service.recoverCancellations({ locator: input.locator });
    const repeatedStop = await service.cancelStart(config.stop);
    const repeatedRecovery = await service.recoverCancellations({ locator: input.locator });
    const rejectedStart = async () => {
      try {
        await service.start(input);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("cancelled_start_was_admitted");
    };
    const oldStartBefore = await rejectedStart();
    const fresh = await service.start({ ...input, startRequestId: "fresh-after-unconfirmed-seal" });
    const oldStartAfter = await rejectedStart();
    await send({
      kind: "recovered",
      pid: process.pid,
      before,
      confirmation,
      after,
      repeatedStop,
      repeatedRecovery,
      oldStartBefore,
      oldStartAfter,
      fresh,
      requests
    });
  } finally {
    await collaboration.shutdown();
  }
}

void run().catch(async (error: unknown) => {
  await send({ kind: "failure", error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
