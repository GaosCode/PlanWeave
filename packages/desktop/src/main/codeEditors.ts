import { execFile } from "node:child_process";
import { app } from "electron";
import type { DesktopVsCodeDetection } from "@planweave-ai/runtime";

const vsCode = {
  label: "Visual Studio Code",
  macOpenName: "Visual Studio Code",
  defaultPath: "/Applications/Visual Studio Code.app"
} as const;
const executableOutputLine = /\r?\n/u;
const detectionTimeoutMs = 2000;
const detectionMaxBufferBytes = 64 * 1024;

function execFileVoid(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: detectionTimeoutMs, maxBuffer: detectionMaxBufferBytes },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: detectionTimeoutMs, maxBuffer: detectionMaxBufferBytes },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

function errorMessage(caught: unknown): string {
  if (caught instanceof Error) {
    return caught.message;
  }
  return String(caught);
}

async function resolveVsCodeIconPath(): Promise<string> {
  if (process.platform === "darwin") {
    await execFileVoid("/usr/bin/open", ["-Ra", vsCode.macOpenName]);
    return vsCode.defaultPath;
  }
  let command = "which";
  let executableName = "code";
  if (process.platform === "win32") {
    command = "where.exe";
    executableName = "code.cmd";
  }
  const executable = await execFileText(command, [executableName]);
  const firstMatch = executable.split(executableOutputLine).find(Boolean);
  if (!firstMatch) {
    throw new Error("Visual Studio Code executable was not found.");
  }
  return firstMatch;
}

async function vsCodeIconDataUrl(iconPath: string): Promise<string> {
  const icon = await app.getFileIcon(iconPath, { size: "normal" });
  const dataUrl = icon.toDataURL();
  if (!dataUrl) {
    throw new Error("Visual Studio Code returned an empty application icon.");
  }
  return dataUrl;
}

export async function detectVsCode(): Promise<DesktopVsCodeDetection> {
  try {
    const iconPath = await resolveVsCodeIconPath();
    try {
      const iconDataUrl = await vsCodeIconDataUrl(iconPath);
      return {
        available: true,
        label: vsCode.label,
        iconDataUrl,
        iconUnavailableReason: null,
        unavailableReason: null
      };
    } catch (caught) {
      return {
        available: true,
        label: vsCode.label,
        iconDataUrl: null,
        iconUnavailableReason: errorMessage(caught),
        unavailableReason: null
      };
    }
  } catch (caught) {
    return {
      available: false,
      label: vsCode.label,
      iconDataUrl: null,
      iconUnavailableReason: null,
      unavailableReason: errorMessage(caught)
    };
  }
}
