#!/usr/bin/env node
import { build } from "esbuild";
import {
  electronBuildOptions,
  prepareElectronBuildOutput,
  writePreloadModuleMetadata
} from "./electron-build.mjs";

await prepareElectronBuildOutput();
const options = electronBuildOptions();
await Promise.all(Object.values(options).map((entry) => build(entry)));

// Parent package.json has "type": "module"; mark the preload dir as CJS so
// Electron loads dist/preload/preload.js as CommonJS (required for sandbox).
await writePreloadModuleMetadata();
