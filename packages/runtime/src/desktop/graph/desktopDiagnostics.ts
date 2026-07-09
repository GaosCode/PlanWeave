import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ValidationIssue } from "../../types.js";

export function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function desktopDiagnostic(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

export function appendDesktopDiagnostic(
  diagnostics: ValidationIssue[],
  diagnostic: ValidationIssue
): void {
  if (
    diagnostics.some(
      (item) =>
        item.code === diagnostic.code &&
        item.path === diagnostic.path &&
        item.message === diagnostic.message
    )
  ) {
    return;
  }
  diagnostics.push(diagnostic);
}

export function appendDesktopDiagnostics(
  diagnostics: ValidationIssue[],
  nextDiagnostics: ValidationIssue[]
): void {
  for (const diagnostic of nextDiagnostics) {
    appendDesktopDiagnostic(diagnostics, diagnostic);
  }
}

export function formatDesktopDiagnostic(diagnostic: ValidationIssue): string {
  return diagnostic.path
    ? `${diagnostic.path}: ${diagnostic.message}`
    : `${diagnostic.code}: ${diagnostic.message}`;
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function resultPath(resultsDir: string, path: string): string {
  const resultRelativePath = toPosixPath(relative(resultsDir, path));
  return resultRelativePath ? `results/${resultRelativePath}` : "results";
}

async function collectResultFiles(
  resultsDir: string,
  root: string,
  diagnostics: ValidationIssue[],
  files: string[]
): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        await collectResultFiles(resultsDir, path, diagnostics, files);
      } else if (entry.isFile() && /\.(md|json|log|txt)$/.test(entry.name)) {
        files.push(path);
      }
    }
  } catch (caught) {
    appendDesktopDiagnostic(
      diagnostics,
      desktopDiagnostic(
        "desktop_results_read_failed",
        `Result files could not be listed: ${errorMessage(caught)}`,
        resultPath(resultsDir, root)
      )
    );
    return;
  }
}

export async function listResultFilesWithDiagnostics(
  resultsDir: string
): Promise<{ files: string[]; diagnostics: ValidationIssue[] }> {
  const diagnostics: ValidationIssue[] = [];
  const files: string[] = [];
  await collectResultFiles(resultsDir, resultsDir, diagnostics, files);
  return { files, diagnostics };
}

export async function readJsonObjectWithDiagnostics(
  path: string,
  resultsDir: string
): Promise<{ value: Record<string, unknown> | null; diagnostics: ValidationIssue[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (caught) {
    return {
      value: null,
      diagnostics: [
        desktopDiagnostic(
          "desktop_result_metadata_read_failed",
          `Result metadata could not be read or parsed: ${errorMessage(caught)}`,
          resultPath(resultsDir, path)
        )
      ]
    };
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { value: parsed as Record<string, unknown>, diagnostics: [] };
  }

  return {
    value: null,
    diagnostics: [
      desktopDiagnostic(
        "desktop_result_metadata_invalid",
        "Result metadata must be a JSON object.",
        resultPath(resultsDir, path)
      )
    ]
  };
}
