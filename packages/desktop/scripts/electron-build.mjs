import { rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopPackageRoot = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
export const distMainDir = resolve(desktopPackageRoot, "dist", "main");
export const distPreloadDir = resolve(desktopPackageRoot, "dist", "preload");

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const commonOptions = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  sourcesContent: false,
  logLevel: "info",
  banner: {
    js: 'import { createRequire as __planweaveCreateRequire } from "node:module"; const require = __planweaveCreateRequire(import.meta.url);'
  },
  external: [...nodeBuiltins, "electron", "electron-liquid-glass", "node-gyp-build"]
};

function buildEndPlugin(name, onBuildEnd) {
  if (!onBuildEnd) return [];
  return [
    {
      name: `planweave-${name}-development-lifecycle`,
      setup(build) {
        build.onEnd((result) => onBuildEnd(name, result));
      }
    }
  ];
}

export function electronBuildOptions(onBuildEnd) {
  const { banner: _mainBanner, ...cjsCommonOptions } = commonOptions;
  return {
    main: {
      ...commonOptions,
      plugins: buildEndPlugin("main", onBuildEnd),
      entryPoints: [resolve(desktopPackageRoot, "src", "main", "main.ts")],
      outfile: resolve(distMainDir, "main.js")
    },
    preload: {
      ...cjsCommonOptions,
      format: "cjs",
      plugins: buildEndPlugin("preload", onBuildEnd),
      entryPoints: [resolve(desktopPackageRoot, "src", "preload", "preload.ts")],
      outfile: resolve(distPreloadDir, "preload.js")
    },
    deploymentArchiveWorker: {
      ...cjsCommonOptions,
      format: "cjs",
      plugins: buildEndPlugin("deployment-archive-worker", onBuildEnd),
      entryPoints: [
        resolve(desktopPackageRoot, "src", "main", "collaboration", "deploymentArchiveWorker.ts")
      ],
      outfile: resolve(distMainDir, "deploymentArchiveWorker.cjs")
    }
  };
}

export async function prepareElectronBuildOutput() {
  await Promise.all([
    rm(distMainDir, { recursive: true, force: true }),
    rm(distPreloadDir, { recursive: true, force: true })
  ]);
}

export async function writePreloadModuleMetadata() {
  await writeFile(
    resolve(distPreloadDir, "package.json"),
    `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`
  );
}
