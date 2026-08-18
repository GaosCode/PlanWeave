import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSelfHostServerResourceDirectory } from "../main/collaboration/selfHostServerResource";

const expectedSuffix = join(
  "packages",
  "desktop",
  "build",
  "generated",
  "planweave-self-host-server"
);

describe("resolveSelfHostServerResourceDirectory", () => {
  it("finds compose.yaml from the Desktop package even when cwd is the repo root", () => {
    const directory = resolveSelfHostServerResourceDirectory({
      packaged: false,
      resourcesPath: "/unused",
      cwd: join(process.cwd())
    });
    expect(directory.endsWith(expectedSuffix)).toBe(true);
    expect(existsSync(join(directory, "compose.yaml"))).toBe(true);
  });

  it("finds compose.yaml when Electron loads the bundled main entry", () => {
    const directory = resolveSelfHostServerResourceDirectory({
      packaged: false,
      resourcesPath: "/unused",
      moduleUrl: pathToFileURL(join(process.cwd(), "packages/desktop/dist/main/main.js")).href,
      cwd: join(process.cwd(), "packages/desktop")
    });
    expect(directory.endsWith(expectedSuffix)).toBe(true);
    expect(existsSync(join(directory, "compose.yaml"))).toBe(true);
  });

  it("keeps Node-resolvable production dependencies in the self-host image", () => {
    const directory = resolveSelfHostServerResourceDirectory({
      packaged: false,
      resourcesPath: "/unused",
      cwd: join(process.cwd())
    });
    const appRoot = join(directory, "image", "app");
    expect(
      existsSync(join(appRoot, "node_modules", "@agentclientprotocol", "sdk", "package.json"))
    ).toBe(true);
    expect(
      existsSync(join(appRoot, "node_modules", "@planweave-ai", "runtime", "package.json"))
    ).toBe(true);
  });

  it("uses the packaged extraResource directory when the app is packaged", () => {
    expect(
      resolveSelfHostServerResourceDirectory({
        packaged: true,
        resourcesPath: "/App.asar.unpacked"
      })
    ).toBe(join("/App.asar.unpacked", "planweave-self-host-server"));
  });
});
