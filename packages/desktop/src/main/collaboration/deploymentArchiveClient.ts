import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { deploymentArchiveFailureCodes as failureCodes } from "../../shared/deploymentArchiveFailureCodes.js";
import {
  deploymentArchiveReplySchema,
  type DeploymentArchiveInput,
  type DeploymentArchiveReply
} from "./deploymentArchiveMessages.js";

const workerFileName = "deploymentArchiveWorker.cjs";

export function resolveDeploymentArchiveWorkerEntry(packagedResourcesPath?: string): URL {
  if (packagedResourcesPath !== undefined) {
    return pathToFileURL(
      join(packagedResourcesPath, "app.asar.unpacked", "dist", "main", workerFileName)
    );
  }
  return new URL(`./${workerFileName}`, import.meta.url);
}

export function deploymentArchiveError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export async function buildDeploymentArchive(
  entry: URL,
  input: DeploymentArchiveInput,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  signal.throwIfAborted();

  let worker: Worker;
  try {
    worker = new Worker(entry, { workerData: input, env: {}, execArgv: [] });
  } catch {
    throw deploymentArchiveError(failureCodes.workerStartFailed);
  }

  return new Promise((resolveArchive, rejectArchive) => {
    let result: DeploymentArchiveReply | undefined;
    let failure: Error | undefined;
    const stopWorker = (code: string) => {
      if (failure) return;
      failure = deploymentArchiveError(code);
      void worker.terminate().catch(() => {
        signal.removeEventListener("abort", onAbort);
        rejectArchive(deploymentArchiveError(failureCodes.workerFailed));
      });
    };
    const onAbort = () => stopWorker(failureCodes.shuttingDown);

    worker.on("message", (message: unknown) => {
      if (failure) return;
      const parsed = deploymentArchiveReplySchema.safeParse(message);
      if (result || !parsed.success) {
        stopWorker(failureCodes.workerProtocolInvalid);
        return;
      }
      result = parsed.data;
    });
    worker.on("messageerror", () => stopWorker(failureCodes.workerProtocolInvalid));
    worker.on("error", () => {
      failure ??= deploymentArchiveError(failureCodes.workerFailed);
    });
    worker.once("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (failure) {
        rejectArchive(failure);
      } else if (code !== 0 || !result) {
        rejectArchive(deploymentArchiveError(failureCodes.workerExited));
      } else if (result.state === "failed") {
        rejectArchive(deploymentArchiveError(failureCodes.buildFailed));
      } else {
        resolveArchive(result.state === "ready" ? new Uint8Array(result.bytes) : null);
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
