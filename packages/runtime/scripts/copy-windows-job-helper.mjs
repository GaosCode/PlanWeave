import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await copyFile(
  resolve(packageRoot, "src/process/windowsJobProcess.ps1"),
  resolve(packageRoot, "dist/process/windowsJobProcess.ps1")
);
