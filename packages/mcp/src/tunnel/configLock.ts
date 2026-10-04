import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withAdvisoryDirectoryLock } from "@planweave-ai/runtime";

export async function withTunnelConfigLock<T>(
  configPath: string,
  work: () => Promise<T>
): Promise<T> {
  const path = resolve(configPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withAdvisoryDirectoryLock(
    { lockPath: `${path}.lock`, operation: "MCP tunnel config commit" },
    work
  );
}
