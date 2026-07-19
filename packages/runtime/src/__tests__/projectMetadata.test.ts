import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonFile } from "../json.js";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import { normalizeProjectMetadata, readProject, resolveProjectWorkspace } from "../project.js";
import {
  parseProjectMetadata,
  readProjectMetadataFile,
  type ProjectMetadata
} from "../projectMetadata.js";

const previousHome = process.env.PLANWEAVE_HOME;

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.PLANWEAVE_HOME;
  } else {
    process.env.PLANWEAVE_HOME = previousHome;
  }
});

function managedMetadata(
  overrides: Partial<ProjectMetadata> & Pick<ProjectMetadata, "id" | "rootPath">
): ProjectMetadata {
  return {
    name: "Demo",
    kind: "managed",
    sourceRoot: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    ...overrides
  };
}

function externalMetadata(
  overrides: Partial<ProjectMetadata> & Pick<ProjectMetadata, "id" | "rootPath" | "sourceRoot">
): ProjectMetadata {
  return {
    name: "External Demo",
    kind: "external",
    createdAt: "2026-06-20T00:00:00.000Z",
    ...overrides
  };
}

describe("projectMetadataSchema / parseProjectMetadata", () => {
  it("accepts current managed and external metadata", () => {
    const managed = managedMetadata({
      id: "demo-aaaa1111",
      rootPath: "/tmp/planweave-home/projects/demo-aaaa1111"
    });
    const external = externalMetadata({
      id: "repo-bbbb2222",
      rootPath: "/Users/me/code/repo",
      sourceRoot: "/Users/me/code/repo"
    });

    expect(parseProjectMetadata(managed, "/tmp/project.json")).toEqual(managed);
    expect(parseProjectMetadata(external, "/tmp/project.json")).toEqual(external);
  });

  it("accepts intentionally supported legacy managed metadata without kind", () => {
    const legacy = {
      id: "legacy-demo",
      name: "legacy-demo",
      rootPath: "/tmp/planweave-home/mcp-projects/legacy-demo",
      createdAt: "2026-06-20T00:00:00.000Z"
    };
    expect(parseProjectMetadata(legacy, "/tmp/project.json")).toEqual(legacy);
  });

  it("rejects missing id, empty id, invalid kind, and bad path fields", () => {
    const base = managedMetadata({
      id: "demo",
      rootPath: "/tmp/planweave-home/projects/demo"
    });

    expect(() => parseProjectMetadata({ ...base, id: undefined }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid:.*id/
    );
    expect(() => parseProjectMetadata({ ...base, id: "" }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid:.*id/
    );
    expect(() => parseProjectMetadata({ ...base, kind: "workspace" }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid:.*kind/
    );
    expect(() =>
      parseProjectMetadata({ ...base, rootPath: "relative/path" }, "/tmp/p.json")
    ).toThrow(/Project metadata at \/tmp\/p\.json is invalid:.*rootPath/);
    expect(() => parseProjectMetadata({ ...base, rootPath: "" }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid:.*rootPath/
    );
    expect(() => parseProjectMetadata({ ...base, sourceRoot: "relative" }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid:.*sourceRoot/
    );
    expect(() => parseProjectMetadata({ ...base, sourceRoot: "" }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid:.*sourceRoot/
    );
  });

  it("rejects malformed field types and unknown properties", () => {
    const base = managedMetadata({
      id: "demo",
      rootPath: "/tmp/planweave-home/projects/demo"
    });

    expect(() => parseProjectMetadata({ ...base, name: 12 }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid:.*name/
    );
    expect(() => parseProjectMetadata({ ...base, createdAt: "not-a-date" }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid:.*createdAt/
    );
    expect(() => parseProjectMetadata({ ...base, extra: true }, "/tmp/p.json")).toThrow(
      /Project metadata at \/tmp\/p\.json is invalid/
    );
  });
});

describe("readProjectMetadataFile", () => {
  it("reads valid metadata and wraps malformed JSON with a path-specific error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-project-meta-"));
    const validPath = join(dir, "valid.json");
    const malformedPath = join(dir, "malformed.json");
    const metadata = managedMetadata({
      id: "demo",
      rootPath: join(dir, "demo")
    });
    await writeJsonFile(validPath, metadata);
    await writeFile(malformedPath, "{", "utf8");

    await expect(readProjectMetadataFile(validPath)).resolves.toEqual(metadata);
    await expect(readProjectMetadataFile(malformedPath)).rejects.toThrow(
      `Project metadata at ${malformedPath} is malformed JSON`
    );
  });

  it("surfaces non-missing I/O failures without masking them as schema errors", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "planweave-project-meta-io-"));
    const blockedDir = join(dir, "blocked");
    const projectFile = join(blockedDir, "project.json");
    await mkdir(blockedDir, { recursive: true });
    await writeJsonFile(projectFile, managedMetadata({ id: "demo", rootPath: blockedDir }));
    await chmod(blockedDir, 0o000);
    try {
      await expect(readProjectMetadataFile(projectFile)).rejects.toMatchObject({
        code: "EACCES"
      });
    } finally {
      await chmod(blockedDir, 0o755);
    }
  });
});

describe("readProject / resolveProjectWorkspace with validated metadata", () => {
  it("reads managed and external projects through the validated boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    process.env.PLANWEAVE_HOME = home;

    const managed = await initManagedWorkspace({ name: "Managed Meta" });
    const managedRoot = await realpath(managed.workspace.workspaceRoot);
    await expect(readProject(managed.workspace.workspaceRoot)).resolves.toMatchObject({
      id: managed.project.id,
      name: "Managed Meta",
      kind: "managed",
      rootPath: managedRoot,
      sourceRoot: null
    });

    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "planweave-repo-")));
    const external = await initWorkspace({ projectRoot: repoRoot });
    await expect(readProject(repoRoot)).resolves.toMatchObject({
      id: external.project.id,
      kind: "external",
      rootPath: repoRoot,
      sourceRoot: repoRoot
    });
  });

  it("returns null when project.json is missing and rejects invalid present files", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    process.env.PLANWEAVE_HOME = home;
    const repoRoot = await mkdtemp(join(tmpdir(), "planweave-repo-"));

    await expect(readProject(repoRoot)).resolves.toBeNull();

    const init = await initWorkspace({ projectRoot: repoRoot });
    await writeFile(init.workspace.projectFile, "{", "utf8");
    await expect(readProject(repoRoot)).rejects.toThrow(
      `Project metadata at ${init.workspace.projectFile} is malformed JSON`
    );

    await writeJsonFile(init.workspace.projectFile, {
      id: "",
      name: "bad",
      rootPath: init.workspace.workspaceRoot,
      kind: "external",
      sourceRoot: repoRoot,
      createdAt: "2026-06-20T00:00:00.000Z"
    });
    await expect(readProject(repoRoot)).rejects.toThrow(
      `Project metadata at ${init.workspace.projectFile} is invalid`
    );
  });

  it("resolves registered workspace roots and rejects mismatched metadata ids", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    process.env.PLANWEAVE_HOME = home;
    const managed = await initManagedWorkspace({ name: "Registered" });
    const workspaceRoot = await realpath(managed.workspace.workspaceRoot);

    await expect(resolveProjectWorkspace(managed.workspace.workspaceRoot)).resolves.toMatchObject({
      id: managed.project.id,
      kind: "managed",
      workspaceRoot
    });

    await writeJsonFile(managed.workspace.projectFile, {
      ...managed.project,
      id: "not-the-directory-name"
    });
    await expect(resolveProjectWorkspace(managed.workspace.workspaceRoot)).rejects.toThrow(
      /does not match workspace directory/
    );
  });

  it("resolves repository roots to the external registered workspace path", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    process.env.PLANWEAVE_HOME = home;
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "planweave-repo-")));
    const init = await initWorkspace({ projectRoot: repoRoot });

    await expect(resolveProjectWorkspace(repoRoot)).resolves.toMatchObject({
      id: init.workspace.id,
      kind: "external",
      rootPath: repoRoot,
      sourceRoot: repoRoot,
      workspaceRoot: init.workspace.workspaceRoot
    });
  });

  it("normalizes intentionally supported legacy managed metadata missing kind", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    process.env.PLANWEAVE_HOME = home;
    const legacyRoot = join(home, "mcp-projects", "legacy-demo");
    await mkdir(legacyRoot, { recursive: true });
    const init = await initWorkspace({ projectRoot: legacyRoot });
    const workspaceRoot = await realpath(init.workspace.workspaceRoot);
    // Keep rootPath under PLANWEAVE_HOME/mcp-projects without forcing realpath so the
    // intentional missing-kind legacy rule can match via path prefix.
    const legacyMetadata = {
      id: init.workspace.id,
      name: "legacy-demo",
      rootPath: legacyRoot,
      createdAt: "2026-06-20T00:00:00.000Z"
    };
    await writeJsonFile(init.workspace.projectFile, legacyMetadata);

    const parsed = await readProjectMetadataFile(init.workspace.projectFile);
    expect(parsed.kind).toBeUndefined();
    expect(
      normalizeProjectMetadata(parsed, {
        planweaveHome: home,
        workspaceRoot: init.workspace.workspaceRoot
      })
    ).toMatchObject({
      id: init.workspace.id,
      kind: "managed",
      rootPath: init.workspace.workspaceRoot,
      sourceRoot: null
    });
    await expect(readProject(init.workspace.workspaceRoot)).resolves.toMatchObject({
      kind: "managed",
      rootPath: workspaceRoot,
      sourceRoot: null
    });
  });
});
