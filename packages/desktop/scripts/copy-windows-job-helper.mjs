import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await copyFile(
  resolve(desktopRoot, "../runtime/src/process/windowsJobProcess.ps1"),
  resolve(desktopRoot, "dist/main/windowsJobProcess.ps1")
);
