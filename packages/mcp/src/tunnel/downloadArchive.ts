import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { tunnelArchiveWorker } from "./downloadArchiveWorker.js";
import { TunnelDownloadError, tunnelDownloadLimits } from "./downloadPolicy.js";
import type { TunnelDownloadOperation } from "./downloadOperation.js";

const workerResult = z.union([
  z.object({ binary: z.instanceof(Uint8Array), binarySha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ error: z.string(), code: z.enum(["invalid_archive", "checksum_mismatch"]) })
]);

export async function verifyAndExtractTunnelBinary(
  zip: Uint8Array,
  binaryName: string,
  expectedHash: string,
  operation: TunnelDownloadOperation
): Promise<{ binary: Uint8Array; binarySha256: string }> {
  operation.check();
  const source = `(async () => {
    const { createRequire } = await import("node:module");
    const { workerData } = await import("node:worker_threads");
    (${tunnelArchiveWorker.toString()})(createRequire(workerData.fflatePath));
  })();`;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      zip,
      binaryName,
      expectedHash,
      maxBytes: tunnelDownloadLimits.binaryBytes,
      maxEntries: tunnelDownloadLimits.entries,
      fflatePath: createRequire(import.meta.url).resolve("fflate")
    }
  });
  const terminate = () => {
    void worker.terminate();
  };
  operation.signal.addEventListener("abort", terminate, { once: true });
  try {
    const result = workerResult.parse(
      await operation.wait(
        new Promise<unknown>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) =>
            reject(new Error(`Tunnel client archive worker exited (${code}).`))
          );
        })
      )
    );
    operation.check();
    if ("error" in result) throw new TunnelDownloadError(result.code, result.error);
    return result;
  } finally {
    operation.signal.removeEventListener("abort", terminate);
    await worker.terminate();
  }
}
