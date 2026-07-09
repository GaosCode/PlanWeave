import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MAX_BYTES = 20_000;

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

function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 220);
}

function normalizePackagePath(path: string): string {
  return path.split("\\").join("/");
}

function boundedContent(
  content: string,
  maxBytes: number
): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return { content, truncated: false };
  }
  let end = Math.min(content.length, maxBytes);
  while (end > 0 && Buffer.byteLength(content.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return { content: content.slice(0, end), truncated: true };
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
  const { workspace, manifest } = await loadPackage(options.projectRoot);
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
    const content = await readFile(absolutePath, "utf8");
    const metadata = await stat(absolutePath);
    files.push({
      path,
      sizeBytes: metadata.size,
      hash: hashContent(content),
      owner: owners.get(path) ?? { kind: "unknown" },
      preview: preview(content),
      contentRef: contentRef("package_file", content, { path })
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
  const { workspace } = await loadPackage(options.projectRoot);
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
  const content = await readFile(absolutePath, "utf8");
  const bounded = boundedContent(content, maxBytes ?? DEFAULT_MAX_BYTES);
  return {
    contentRef: contentRef(kind, content, { path: normalizePackagePath(path) }),
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
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  if (options.target === "project") {
    const content = await readFile(workspace.projectPromptFile, "utf8");
    const bounded = boundedContent(content, options.maxBytes ?? DEFAULT_MAX_BYTES);
    return {
      contentRef: contentRef("prompt_source", content, { path: "policy/project-prompt.md" }),
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
  const surface = await renderPromptSurface({
    projectRoot: options.projectRoot,
    ref: options.ref,
    allowMissingPromptSources: true
  });
  const bounded = boundedContent(surface.markdown, options.maxBytes ?? DEFAULT_MAX_BYTES);
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
