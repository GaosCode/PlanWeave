import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "./loadPackage.js";
import { resolvePackagePath } from "./resolvePackagePath.js";
import { renderPromptSurface } from "../taskManager/index.js";
import type {
  PackageContentOwner,
  PackageContentReadResult,
  PackageContentRef,
  PackageFileListResult,
  PackageFileSummary,
  PackageWorkspaceRef
} from "../types.js";

import { MAX_LIST_READ_BYTES, normalizeContentMaxBytes } from "./contentReadPolicy.js";
import { readBoundedUtf8File, utf8Prefix } from "./boundedUtf8Reader.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Package file list limit must be a positive integer.");
  }
  return Math.min(limit, MAX_LIMIT);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const match = /^next:(\d+)$/.exec(cursor);
  if (!match) {
    throw new Error(`Invalid package file cursor '${cursor}'.`);
  }
  return Number.parseInt(match[1], 10);
}

function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function normalizePackagePath(path: string): string {
  return path.split("\\").join("/");
}

async function visitFiles(root: string, dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await visitFiles(root, absolutePath, files);
    } else if (entry.isFile()) {
      files.push(normalizePackagePath(relative(root, absolutePath)));
    }
  }
}

function ownerMapForPackage(
  manifest: Awaited<ReturnType<typeof loadPackage>>["manifest"]
): Map<string, PackageContentOwner> {
  const owners = new Map<string, PackageContentOwner>([["manifest.json", { kind: "manifest" }]]);
  for (const node of manifest.nodes) {
    owners.set(node.prompt, { kind: "task", ref: node.id });
    for (const block of node.blocks) {
      owners.set(block.prompt, { kind: "block", ref: `${node.id}#${block.id}` });
    }
  }
  return owners;
}

function contentRef(
  kind: PackageContentRef["kind"],
  content: string,
  input: { path?: string; ref?: string }
): PackageContentRef {
  return {
    kind,
    ...input,
    hash: hashContent(content),
    sizeBytes: Buffer.byteLength(content, "utf8")
  };
}

export async function listPackageFiles(options: {
  projectRoot: PackageWorkspaceRef;
  limit?: number;
  cursor?: string;
}): Promise<PackageFileListResult> {
  const limit = normalizeLimit(options.limit);
  const offset = parseCursor(options.cursor);
  const pageBudget = { remainingBytes: MAX_LIST_READ_BYTES };
  const { workspace, manifest, manifestContent } = await loadPackage(options.projectRoot, {
    boundedManifest: true,
    manifestReadBudget: pageBudget
  });
  const paths: string[] = [];
  await visitFiles(workspace.packageDir, workspace.packageDir, paths);
  paths.sort((left, right) => left.localeCompare(right));
  const owners = ownerMapForPackage(manifest);
  const selected = paths.slice(offset, offset + limit);
  const files: PackageFileSummary[] = [];
  for (const path of selected) {
    const absolutePath = await resolvePackagePath(workspace.packageDir, path, {
      requireExisting: true
    });
    const result =
      path === "manifest.json" && manifestContent
        ? manifestContent
        : await readBoundedUtf8File(absolutePath, { maxBytes: 0, pageBudget });
    files.push({
      path,
      sizeBytes: result.physicalSizeBytes,
      hash: result.hash,
      owner: owners.get(path) ?? { kind: "unknown" },
      preview: result.preview,
      contentRef: { kind: "package_file", path, hash: result.hash, sizeBytes: result.sizeBytes }
    });
  }
  const nextOffset = offset + limit;
  return {
    files,
    pagination: {
      limit,
      cursor: options.cursor ?? null,
      nextCursor: nextOffset < paths.length ? `next:${nextOffset}` : null,
      total: paths.length,
      hasMore: nextOffset < paths.length
    }
  };
}

export async function readPackageFile(options: {
  projectRoot: PackageWorkspaceRef;
  path: string;
  maxBytes?: number;
}): Promise<PackageContentReadResult> {
  normalizeContentMaxBytes(options.maxBytes);
  const { workspace } = await loadPackage(options.projectRoot, { boundedManifest: true });
  return readBoundedPackagePath(
    workspace.packageDir,
    options.path,
    "package_file",
    options.maxBytes
  );
}

async function readBoundedPackagePath(
  packageDir: string,
  path: string,
  kind: PackageContentRef["kind"],
  maxBytes: number | undefined
): Promise<PackageContentReadResult> {
  const absolutePath = await resolvePackagePath(packageDir, path, { requireExisting: true });
  const bounded = await readBoundedUtf8File(absolutePath, {
    maxBytes: normalizeContentMaxBytes(maxBytes)
  });
  return {
    contentRef: {
      kind,
      path: normalizePackagePath(path),
      hash: bounded.hash,
      sizeBytes: bounded.sizeBytes
    },
    content: bounded.content,
    truncated: bounded.truncated
  };
}

export async function readPromptSource(options: {
  projectRoot: PackageWorkspaceRef;
  target: "project" | "task" | "block";
  taskId?: string;
  blockRef?: string;
  maxBytes?: number;
}): Promise<PackageContentReadResult> {
  normalizeContentMaxBytes(options.maxBytes);
  const { workspace, manifest } = await loadPackage(options.projectRoot, { boundedManifest: true });
  if (options.target === "project") {
    const bounded = await readBoundedUtf8File(workspace.projectPromptFile, {
      maxBytes: normalizeContentMaxBytes(options.maxBytes)
    });
    return {
      contentRef: {
        kind: "prompt_source",
        path: "policy/project-prompt.md",
        hash: bounded.hash,
        sizeBytes: bounded.sizeBytes
      },
      content: bounded.content,
      truncated: bounded.truncated
    };
  }
  if (options.target === "task") {
    if (!options.taskId) {
      throw new Error("taskId is required for task prompt source reads.");
    }
    const task = manifest.nodes.find((node) => node.id === options.taskId);
    if (!task) {
      throw new Error(`Task '${options.taskId}' does not exist.`);
    }
    return readBoundedPackagePath(
      workspace.packageDir,
      task.prompt,
      "prompt_source",
      options.maxBytes
    );
  }
  if (!options.blockRef) {
    throw new Error("blockRef is required for block prompt source reads.");
  }
  const { taskId, blockId } = parseBlockRef(options.blockRef);
  const task = manifest.nodes.find((node) => node.id === taskId);
  const block = task?.blocks.find((candidate) => candidate.id === blockId);
  if (!task || !block) {
    throw new Error(`Block '${options.blockRef}' does not exist.`);
  }
  return readBoundedPackagePath(
    workspace.packageDir,
    block.prompt,
    "prompt_source",
    options.maxBytes
  );
}

export async function readRenderedPrompt(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  maxBytes?: number;
}): Promise<PackageContentReadResult> {
  const maxBytes = normalizeContentMaxBytes(options.maxBytes);
  const surface = await renderPromptSurface({
    projectRoot: options.projectRoot,
    ref: options.ref,
    allowMissingPromptSources: true
  });
  const bounded = utf8Prefix(surface.markdown, maxBytes);
  return {
    contentRef: contentRef("rendered_prompt", surface.markdown, { ref: options.ref }),
    content: bounded.content,
    truncated: bounded.truncated
  };
}

export async function getPromptSources(options: { projectRoot: PackageWorkspaceRef; ref: string }) {
  const surface = await renderPromptSurface({
    projectRoot: options.projectRoot,
    ref: options.ref,
    allowMissingPromptSources: true
  });
  return {
    ref: options.ref,
    sources: surface.sources
  };
}
