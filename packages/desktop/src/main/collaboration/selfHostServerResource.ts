import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const resourceName = "planweave-self-host-server";

/**
 * Unpackaged resources live in the Desktop package.
 * import.meta.url is the bundled main file (`dist/main/main.js`) in Electron,
 * not this source file, so candidates are checked by compose.yaml existence.
 */
export function resolveSelfHostServerResourceDirectory(input: {
  packaged: boolean;
  resourcesPath: string;
  moduleUrl?: string;
  cwd?: string;
}): string {
  if (input.packaged) return join(input.resourcesPath, resourceName);
  const here = dirname(fileURLToPath(input.moduleUrl ?? import.meta.url));
  const cwd = input.cwd ?? process.cwd();
  const candidates = [
    join(here, "../../build/generated", resourceName),
    join(here, "../../../build/generated", resourceName),
    join(cwd, "build/generated", resourceName),
    join(cwd, "packages/desktop/build/generated", resourceName)
  ];
  const found = candidates.find((directory) => existsSync(join(directory, "compose.yaml")));
  if (!found) throw new Error("server_self_host_resource_missing");
  return found;
}
