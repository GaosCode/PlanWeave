import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentVersionTransferMediaType } from "@planweave-ai/collaboration-protocol/content/transfer";
import { exampleLoopbackConnectionProfile } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { downloadWorkspaceCanvasFork } from "../main/collaboration/workspaceCanvasDownload.js";
import { DesktopSettingsStore } from "../main/desktopSettingsStore.js";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { withCanvasMapLayoutDiskLocks } from "../../../runtime/src/desktop/canvasMapLayout.js";
import { captureAuthorizedCanvasContent } from "../../../runtime/src/desktop/authorizedCanvasContent.js";
import { createManagedProjectFromAuthoritativeContent } from "../../../runtime/src/desktop/contentVersionMaterializer.js";
import {
  createProjectFromTaskCanvas,
  resolveTaskCanvasWorkspace
} from "../../../runtime/src/desktop/canvasApi.js";
import {
  getDesktopLayoutDirect,
  saveDesktopLayoutDirect
} from "../../../runtime/src/desktop/layoutStore.js";
import * as advisoryLocks from "../../../runtime/src/fs/advisoryDirectoryLock.js";
import * as optionalFiles from "../../../runtime/src/fs/optionalFile.js";
import { withProjectMutationLock } from "../../../runtime/src/fs/withProjectMutationLock.js";
import {
  authoritativeImportReservationFile,
  initManagedWorkspace
} from "../../../runtime/src/initWorkspace.js";
import { withPackageFileConsistency } from "../../../runtime/src/package/packageFileConsistency.js";
import * as packageConsistency from "../../../runtime/src/package/packageFileConsistency.js";
import { resolveProjectWorkspaceInHome } from "../../../runtime/src/project.js";
import { linkProjectSourceRoot, renameProject } from "../../../runtime/src/desktop/projectApi.js";
import { setSourceDefaultProject } from "../../../runtime/src/desktop/sourceDefaultProject.js";
import { createManagedProjectId } from "../../../runtime/src/projectId.js";

vi.mock("@planweave-ai/runtime", () => import("../../../runtime/src/index.js"));

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettings;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Home lifecycle barrier timed out")), 3_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function hold(lock: (operation: () => Promise<void>) => Promise<void>) {
  const entered = deferred();
  const released = deferred();
  const holding = lock(async () => {
    entered.resolve();
    await released.promise;
  });
  try {
    await bounded(Promise.race([entered.promise, holding]));
  } catch (error) {
    released.resolve();
    await Promise.allSettled([holding]);
    throw error;
  }
  return { holding, release: released.resolve };
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    )
    .finally(() => {
      settled = true;
    });
  return { outcome, isSettled: () => settled };
}

async function tree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      entries[`${entry.name}/`] = "directory";
      for (const [name, bytes] of Object.entries(await tree(path))) {
        entries[`${entry.name}/${name}`] = bytes;
      }
    } else {
      entries[entry.name] = (await readFile(path)).toString("base64");
    }
  }
  return entries;
}

function withoutProject(entries: Record<string, string>, id: string) {
  return Object.fromEntries(
    Object.entries(entries).filter(([path]) => !path.startsWith(`projects/${id}/`))
  );
}

async function fixture(automaticName = false, reservationTokenB?: string) {
  const owner = await mkdtemp(join(tmpdir(), "pw-managed-home-lifecycle-"));
  directories.push(owner);
  const homeA = join(owner, "home-a");
  const homeB = join(owner, "home-b");
  await Promise.all([mkdir(homeA), mkdir(homeB)]);
  const source = await createTestWorkspace(basicManifest(), {
    planweaveHome: homeA,
    trustPackageExecutors: false
  });
  directories.push(source.root);
  await saveDesktopLayoutDirect(source.init.workspace, {
    version: "desktop-layout/v1",
    projectId: source.init.workspace.id,
    nodes: [{ nodeId: "T-001", x: 120, y: 80 }],
    updatedAt: "2026-08-01T00:00:00.000Z"
  });
  const { content } = await captureAuthorizedCanvasContent({ projectRoot: source.init.workspace });
  const projectName = automaticName ? "Test Plan 3" : "Home Lifecycle Import";
  const id = createManagedProjectId(projectName);
  if (automaticName) {
    await initManagedWorkspace({ name: "Test Plan", projectGraph: true });
    await initManagedWorkspace({ name: "Test Plan 2", projectGraph: true });
  }
  process.env.PLANWEAVE_HOME = homeB;
  if (reservationTokenB) {
    await createManagedProjectFromAuthoritativeContent({
      authorityProjectId: source.init.workspace.id,
      content,
      projectName,
      reservationToken: reservationTokenB
    });
  }
  const existingB = await initManagedWorkspace({
    name: projectName,
    projectGraph: true,
    ...(reservationTokenB ? { contentReplicaReservationToken: reservationTokenB } : {})
  });
  if (automaticName) {
    await initManagedWorkspace({ name: "Test Plan", projectGraph: true });
    await initManagedWorkspace({ name: "Test Plan 4", projectGraph: true });
  }
  await writeFile(
    join(existingB.workspace.resultsDir, "unrelated-history.txt"),
    "preserve B history\n"
  );
  await Promise.all([
    writeFile(join(homeA, "config", "home-owner.txt"), "A config\n"),
    writeFile(join(homeB, "config", "home-owner.txt"), "B config\n")
  ]);
  const settingsFile = join(owner, "desktop-settings.json");
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = settingsFile;
  const settings = new DesktopSettingsStore({ settingsFile, planweaveHomeBaseline: homeA });
  await settings.mergePatch({ planweaveHome: homeA });
  const beforeA = await tree(homeA);
  const beforeB = await tree(homeB);
  return {
    homeA,
    homeB,
    settings,
    settingsFile,
    content,
    projectName,
    id,
    beforeA,
    beforeB,
    authorityProjectId: source.init.workspace.id,
    sourceRoot: source.root,
    rootA: join(homeA, "projects", id)
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertHomeBUnchanged(f: Fixture, settingsBytes: string) {
  expect(await tree(f.homeB)).toEqual(f.beforeB);
  expect(await readFile(f.settingsFile, "utf8")).toBe(settingsBytes);
  expect(process.env.PLANWEAVE_HOME).toBe(f.homeB);
}

async function assertImportedInA(
  f: Fixture,
  created: Awaited<ReturnType<typeof createManagedProjectFromAuthoritativeContent>>
) {
  expect(created.project).toMatchObject({
    projectId: f.id,
    name: f.projectName,
    rootPath: f.rootA,
    workspaceRoot: f.rootA,
    activeCanvasId: "default",
    kind: "managed"
  });
  expect(created.canvasId).toBe("default");
  for (const member of f.content.members.filter((member) => member.kind !== "desktop_layout")) {
    expect(
      await readFile(join(f.rootA, "canvases", "default", "package", member.path), "utf8")
    ).toBe(member.content);
  }
  const projectWorkspace = await resolveProjectWorkspaceInHome(f.rootA, f.homeA);
  const canvasWorkspace = await resolveTaskCanvasWorkspace(projectWorkspace, "default");
  expect(
    JSON.parse(
      await readFile(join(canvasWorkspace.workspaceRoot, "desktop", "layout.json"), "utf8")
    )
  ).toMatchObject({ projectId: f.id, nodes: [{ nodeId: "T-001", x: 120, y: 80 }] });
  expect(await getDesktopLayoutDirect(canvasWorkspace)).toMatchObject({
    projectId: f.id,
    nodes: [{ nodeId: "T-001", x: 120, y: 80 }]
  });
  expect(withoutProject(await tree(f.homeA), f.id)).toEqual(withoutProject(f.beforeA, f.id));
}

function watchProjectLockRequest(operationName = "project-mutation") {
  const requested = deferred();
  const realLock = advisoryLocks.withAdvisoryDirectoryLock;
  vi.spyOn(advisoryLocks, "withAdvisoryDirectoryLock").mockImplementation((options, operation) => {
    const pending = realLock(options, operation);
    if (options.operation === operationName) requested.resolve();
    return pending;
  });
  return requested.promise;
}

async function seedLinkedDefaults(f: Fixture) {
  await initManagedWorkspace({ name: f.projectName, projectGraph: true });
  await linkProjectSourceRoot(f.id, f.sourceRoot);
  const entryA = await setSourceDefaultProject(f.sourceRoot, f.id);
  await f.settings.mergePatch({ planweaveHome: f.homeB });
  await linkProjectSourceRoot(f.id, f.sourceRoot);
  await setSourceDefaultProject(f.sourceRoot, f.id);
  await f.settings.mergePatch({ planweaveHome: f.homeA });
  f.beforeA = await tree(f.homeA);
  f.beforeB = await tree(f.homeB);
  return entryA;
}

describe("managed content ownership across Desktop Home settings changes", () => {
  it.each([
    false,
    true
  ])("keeps initialization, content and overview in A after switching to B (automatic name=%s)", async (automaticName) => {
    const f = await fixture(automaticName);
    const barrier = await hold((operation) =>
      withPackageFileConsistency(
        [
          join(f.rootA, "desktop", "layout.json"),
          join(f.rootA, "canvases", "default", "desktop", "layout.json")
        ],
        operation
      )
    );
    const creation = observe(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: f.authorityProjectId,
        content: f.content,
        ...(automaticName ? {} : { projectName: f.projectName })
      })
    );
    try {
      await bounded(
        (async () => {
          while (!(await optionalFiles.optionalStat(join(f.rootA, "project-graph.json")))) {
            if (creation.isSettled())
              throw new Error("Creation settled before the initialized layout barrier");
            await delay(5);
          }
        })()
      );
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      barrier.release();
      const result = await bounded(creation.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      await assertImportedInA(f, result.value);
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, creation.outcome]);
    }
  });

  it("propagates a real layout identity failure and rolls back only newly initialized A", async () => {
    const f = await fixture();
    const barrier = await hold((operation) =>
      withPackageFileConsistency(
        [
          join(f.rootA, "desktop", "layout.json"),
          join(f.rootA, "canvases", "default", "desktop", "layout.json")
        ],
        operation
      )
    );
    const creation = observe(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: "different-authority-owner",
        content: f.content,
        projectName: f.projectName
      })
    );
    try {
      await bounded(
        (async () => {
          while (!(await optionalFiles.optionalStat(join(f.rootA, "project-graph.json")))) {
            if (creation.isSettled())
              throw new Error("Creation settled before the initialized layout barrier");
            await delay(5);
          }
        })()
      );
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      barrier.release();
      const result = await bounded(creation.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      expect(await tree(f.homeA)).toEqual(f.beforeA);
      expect(result).toMatchObject({
        status: "rejected",
        reason: new Error("content_version_layout_invalid")
      });
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, creation.outcome]);
    }
  });

  it.each([
    "replica",
    "fork",
    "reserved-new",
    "reserved-resume",
    "reserved-conflict"
  ] as const)("keeps queued %s admission and writes in the Home captured before lock acquisition", async (mode) => {
    const f = await fixture(
      false,
      mode === "reserved-conflict" ? "different-reservation" : undefined
    );
    const token = "reservation-owned-by-A";
    if (mode === "reserved-resume" || mode === "reserved-conflict") {
      await createManagedProjectFromAuthoritativeContent({
        authorityProjectId: f.authorityProjectId,
        content: f.content,
        projectName: f.projectName,
        expectedProjectId: f.id,
        reservationToken: token
      });
      f.beforeA = await tree(f.homeA);
    }
    const barrier = await hold((operation) => withProjectMutationLock(f.rootA, operation));
    const lockRequested = watchProjectLockRequest();
    const sourceLineage = {
      scope: {
        workspaceId: "source-workspace",
        projectId: f.authorityProjectId,
        canvasId: "default"
      },
      revision: 3,
      content: {
        versionId: `version-${f.content.canonicalDigest}`,
        canonicalDigest: f.content.canonicalDigest,
        verification: "complete" as const
      }
    };
    const creation = observe(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: f.authorityProjectId,
        content: f.content,
        projectName: f.projectName,
        ...(mode === "fork" ? { importMode: "fork", sourceLineage } : {}),
        ...(mode.startsWith("reserved")
          ? {
              expectedProjectId: f.id,
              reservationToken: mode === "reserved-conflict" ? "different-reservation" : token,
              resumeReservedProject: mode !== "reserved-new"
            }
          : {})
      })
    );
    try {
      await bounded(lockRequested);
      expect(creation.isSettled()).toBe(false);
      expect(await tree(f.homeA)).toEqual(f.beforeA);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      barrier.release();
      const result = await bounded(creation.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      if (mode === "reserved-conflict") {
        expect(result).toMatchObject({
          status: "rejected",
          reason: new Error("content_local_project_reservation_conflict")
        });
        expect(await tree(f.homeA)).toEqual(f.beforeA);
      } else {
        expect(result.status).toBe("fulfilled");
        if (result.status !== "fulfilled") throw result.reason;
        await assertImportedInA(f, result.value);
        if (mode === "fork") {
          expect(result.value.lineage).toEqual({
            schemaVersion: "workspace-fork-lineage/v1",
            writeback: false,
            source: sourceLineage
          });
          expect(
            JSON.parse(await readFile(join(f.rootA, "workspace-fork-lineage.json"), "utf8"))
          ).toEqual(result.value.lineage);
          expect(
            await optionalFiles.optionalStat(join(f.rootA, authoritativeImportReservationFile))
          ).toBeNull();
        } else if (mode.startsWith("reserved")) {
          expect(await readFile(join(f.rootA, authoritativeImportReservationFile), "utf8")).toBe(
            `${token}\n`
          );
        }
      }
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, creation.outcome]);
    }
  });

  it("captures A before automatic name enumeration awaits and queues that A name", async () => {
    const f = await fixture(true);
    const barrier = await hold((operation) => withProjectMutationLock(f.rootA, operation));
    const enumerated = deferred();
    const resumeEnumeration = deferred();
    const realRead = optionalFiles.optionalReaddir;
    vi.spyOn(optionalFiles, "optionalReaddir").mockImplementation(async (path, options) => {
      const entries = await realRead(path, options);
      if (path === join(f.homeA, "projects")) {
        enumerated.resolve();
        await resumeEnumeration.promise;
      }
      return entries;
    });
    const lockRequested = watchProjectLockRequest();
    const creation = observe(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: f.authorityProjectId,
        content: f.content
      })
    );
    try {
      await bounded(enumerated.promise);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      resumeEnumeration.resolve();
      await bounded(lockRequested);
      barrier.release();
      const result = await bounded(creation.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      await assertImportedInA(f, result.value);
    } finally {
      resumeEnumeration.resolve();
      barrier.release();
      await Promise.allSettled([barrier.holding, creation.outcome]);
    }
  });

  it("keeps direct managed initialization config and graph in A while its project lock is queued", async () => {
    const f = await fixture();
    await Promise.all([
      unlink(join(f.homeA, "config", "global-prompt.md")),
      unlink(join(f.homeB, "config", "global-prompt.md"))
    ]);
    f.beforeA = await tree(f.homeA);
    f.beforeB = await tree(f.homeB);
    const barrier = await hold((operation) => withProjectMutationLock(f.rootA, operation));
    const lockRequested = watchProjectLockRequest();
    const initialization = observe(
      initManagedWorkspace({ name: f.projectName, projectGraph: true })
    );
    try {
      await bounded(lockRequested);
      expect(initialization.isSettled()).toBe(false);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      barrier.release();
      const result = await bounded(initialization.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value.workspace).toMatchObject({
        id: f.id,
        workspaceRoot: f.rootA,
        planweaveHome: f.homeA
      });
      expect(result.value.project).toMatchObject({ id: f.id, rootPath: f.rootA });
      expect(await readFile(join(f.homeA, "config", "global-prompt.md"), "utf8")).toBe(
        "# Global Prompt\n"
      );
      expect(JSON.parse(await readFile(join(f.rootA, "project-graph.json"), "utf8"))).toMatchObject(
        { version: "plan-project/v1", canvases: [expect.objectContaining({ id: "default" })] }
      );
      const afterA = await tree(f.homeA);
      delete afterA["config/global-prompt.md"];
      expect(withoutProject(afterA, f.id)).toEqual(f.beforeA);
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, initialization.outcome]);
    }
  });

  it("copies the captured A canvas into A when a same-name B project exists during the target lock wait", async () => {
    const f = await fixture();
    const sourceWorkspace = await resolveTaskCanvasWorkspace(f.sourceRoot, "default");
    await saveDesktopLayoutDirect(sourceWorkspace, {
      version: "desktop-layout/v1",
      projectId: f.authorityProjectId,
      nodes: [{ nodeId: "T-001", x: 120, y: 80 }],
      updatedAt: "2026-08-01T00:00:00.000Z"
    });
    f.beforeA = await tree(f.homeA);
    const barrier = await hold((operation) => withProjectMutationLock(f.rootA, operation));
    const lockRequested = watchProjectLockRequest();
    const copying = observe(
      createProjectFromTaskCanvas(f.sourceRoot, "default", { name: f.projectName })
    );
    try {
      await bounded(lockRequested);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      barrier.release();
      const result = await bounded(copying.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value).toMatchObject({
        projectId: f.id,
        rootPath: f.rootA,
        workspaceRoot: f.rootA,
        name: f.projectName,
        activeCanvasId: "default",
        taskCanvases: [expect.objectContaining({ taskCount: 1 })]
      });
      const packageRoot = join(f.rootA, "canvases", "default", "package");
      for (const prompt of f.content.members.filter((member) => member.kind.endsWith("_prompt"))) {
        expect(await readFile(join(packageRoot, prompt.path), "utf8")).toBe(prompt.content);
      }
      expect(JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"))).toMatchObject({
        project: { title: f.projectName }
      });
      expect(await readdir(join(f.rootA, "canvases", "default", "results"))).toEqual([]);
      const projectWorkspace = await resolveProjectWorkspaceInHome(f.rootA, f.homeA);
      const targetWorkspace = await resolveTaskCanvasWorkspace(projectWorkspace, "default");
      expect(
        await readFile(join(targetWorkspace.workspaceRoot, "desktop", "layout.json"), "utf8")
      ).toBe(await readFile(join(sourceWorkspace.workspaceRoot, "desktop", "layout.json"), "utf8"));
      expect(await getDesktopLayoutDirect(targetWorkspace)).toMatchObject({
        projectId: f.id,
        nodes: [{ nodeId: "T-001", x: 120, y: 80 }]
      });
      expect(
        JSON.parse(await readFile(join(f.rootA, "canvases", "default", "state.json"), "utf8"))
      ).toMatchObject({ tasks: {}, blocks: {}, feedback: {}, currentRefs: [] });
      expect(withoutProject(await tree(f.homeA), f.id)).toEqual(f.beforeA);
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, copying.outcome]);
    }
  });

  it("keeps a downloaded fork in A when Desktop settings switch Home while the content head request waits", async () => {
    const f = await fixture();
    const headRequested = deferred();
    const releaseHead = deferred();
    const scope = {
      workspaceId: "source-workspace",
      projectId: f.authorityProjectId,
      canvasId: "default"
    };
    const completed = {
      versionId: `version-${f.content.canonicalDigest}`,
      canonicalDigest: f.content.canonicalDigest,
      verification: "complete" as const
    };
    const header = {
      type: "header",
      schemaVersion: "content-version/v1",
      scope,
      completed,
      canonicalDigest: f.content.canonicalDigest,
      totalBytes: f.content.totalBytes,
      memberCount: f.content.members.length,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdBy: { kind: "human", id: "source-owner" }
    };
    const frames = [
      header,
      ...f.content.members.map((member, index) => ({ type: "member", index, member })),
      {
        type: "complete",
        canonicalDigest: f.content.canonicalDigest,
        totalBytes: f.content.totalBytes,
        memberCount: f.content.members.length
      }
    ];
    const client = new CollaborationClient({
      profile: { ...exampleLoopbackConnectionProfile, projectId: f.authorityProjectId },
      credential: { getDeviceToken: () => "test-device-token" },
      request: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/content/head")) {
          headRequested.resolve();
          await releaseHead.promise;
          return new Response(
            JSON.stringify({
              schemaVersion: "content-version/v1",
              scope,
              revision: 3,
              content: completed,
              advancedAt: "2026-08-01T00:00:00.000Z"
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (path.endsWith("/content/fetch")) {
          return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
            headers: { "content-type": contentVersionTransferMediaType }
          });
        }
        throw new Error(`Unexpected download request ${path}`);
      }
    });
    const downloading = observe(
      downloadWorkspaceCanvasFork({ client, rawInput: { ...scope, projectName: f.projectName } })
    );
    try {
      await bounded(headRequested.promise);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      releaseHead.resolve();
      const result = await bounded(downloading.outcome);
      await assertHomeBUnchanged(f, settingsBytes);
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value).toMatchObject({
        locator: { kind: "local", projectId: f.id, canvasId: "default" },
        localProjectId: f.id,
        writeback: false,
        lineage: { source: { scope, revision: 3, content: completed } }
      });
      expect(
        JSON.parse(await readFile(join(f.rootA, "workspace-fork-lineage.json"), "utf8"))
      ).toEqual(result.value.lineage);
      for (const member of f.content.members.filter((member) => member.kind !== "desktop_layout")) {
        expect(
          await readFile(join(f.rootA, "canvases", "default", "package", member.path), "utf8")
        ).toBe(member.content);
      }
      const projectWorkspace = await resolveProjectWorkspaceInHome(f.rootA, f.homeA);
      const canvasWorkspace = await resolveTaskCanvasWorkspace(projectWorkspace, "default");
      expect(
        JSON.parse(
          await readFile(join(canvasWorkspace.workspaceRoot, "desktop", "layout.json"), "utf8")
        )
      ).toMatchObject({
        projectId: f.id,
        nodes: [{ nodeId: "T-001", x: 120, y: 80 }]
      });
      expect(await getDesktopLayoutDirect(canvasWorkspace)).toMatchObject({
        projectId: f.id,
        nodes: [{ nodeId: "T-001", x: 120, y: 80 }]
      });
      expect(withoutProject(await tree(f.homeA), f.id)).toEqual(f.beforeA);
    } finally {
      releaseHead.resolve();
      await Promise.allSettled([downloading.outcome]);
      client.dispose();
    }
  });

  it("rolls back newly created A when real graph persistence fails before initialization returns", async () => {
    const f = await fixture();
    const graphPath = join(f.rootA, "project-graph.json");
    const barrier = await hold((operation) => withPackageFileConsistency([graphPath], operation));
    const graphWriteRequested = deferred();
    const realConsistency = packageConsistency.withPackageFileConsistency;
    vi.spyOn(packageConsistency, "withPackageFileConsistency").mockImplementation(
      (roots, operation) => {
        const pending = realConsistency(roots, operation);
        if (roots.includes(graphPath)) graphWriteRequested.resolve();
        return pending;
      }
    );
    const creation = observe(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: f.authorityProjectId,
        content: f.content,
        projectName: f.projectName
      })
    );
    try {
      await bounded(graphWriteRequested.promise);
      expect(await optionalFiles.optionalStat(join(f.rootA, "project.json"))).not.toBeNull();
      await mkdir(graphPath);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      barrier.release();
      const result = await bounded(creation.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      expect(await tree(f.homeA)).toEqual(f.beforeA);
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("Graph persistence unexpectedly succeeded");
      expect(result.reason).toBeInstanceOf(Error);
      expect(result.reason).not.toBeInstanceOf(AggregateError);
      expect(result.reason).toMatchObject({
        code: expect.stringMatching(/^(EISDIR|EPERM|ENOTEMPTY)$/),
        message: expect.stringContaining("project-graph.json")
      });
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, creation.outcome]);
    }
  });

  it("refuses rollback deletion of a content-identical replacement of its newly created A root", async () => {
    const f = await fixture();
    const barrier = await hold((operation) =>
      withPackageFileConsistency(
        [
          join(f.rootA, "desktop", "layout.json"),
          join(f.rootA, "canvases", "default", "desktop", "layout.json")
        ],
        operation
      )
    );
    const creation = observe(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: "different-authority-owner",
        content: f.content,
        projectName: f.projectName
      })
    );
    try {
      await bounded(
        (async () => {
          while (!(await optionalFiles.optionalStat(join(f.rootA, "project-graph.json")))) {
            if (creation.isSettled())
              throw new Error("Creation settled before the initialized layout barrier");
            await delay(5);
          }
        })()
      );
      const retiredRoot = join(f.homeA, "..", "retired-created-project");
      await rename(f.rootA, retiredRoot);
      await cp(retiredRoot, f.rootA, { recursive: true });
      await writeFile(join(f.rootA, "replacement-owner.txt"), "preserve replacement instance\n");
      const replacementBytes = await tree(f.rootA);
      const beforeRollbackA = await tree(f.homeA);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      barrier.release();
      const result = await bounded(creation.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      expect(await tree(f.rootA)).toEqual(replacementBytes);
      expect(await tree(f.homeA)).toEqual(beforeRollbackA);
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("Replaced project unexpectedly succeeded");
      expect(result.reason).toBeInstanceOf(AggregateError);
      if (!(result.reason instanceof AggregateError)) throw result.reason;
      expect(result.reason.errors).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/workspace identity changed/i) }),
        expect.objectContaining({ message: expect.stringMatching(/workspace identity changed/i) })
      ]);
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, creation.outcome]);
    }
  });

  it.each([
    false,
    true
  ])("rejects an existing unregistered target directory without adopting or changing its contents (reservation request=%s)", async (reservationRequest) => {
    const f = await fixture();
    await mkdir(f.rootA);
    await writeFile(join(f.rootA, "unregistered-owner.txt"), "existing directory owner\n");
    f.beforeA = await tree(f.homeA);
    const settingsBytes = await readFile(f.settingsFile, "utf8");
    await expect(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: f.authorityProjectId,
        content: f.content,
        projectName: f.projectName,
        ...(reservationRequest ? { reservationToken: "unowned-directory-token" } : {})
      })
    ).rejects.toThrow(
      reservationRequest
        ? "content_local_project_reservation_conflict"
        : "content_local_project_name_conflict"
    );
    expect(await tree(f.homeA)).toEqual(f.beforeA);
    expect(await tree(f.homeB)).toEqual(f.beforeB);
    expect(await readFile(f.settingsFile, "utf8")).toBe(settingsBytes);
    expect(process.env.PLANWEAVE_HOME).toBe(f.homeA);
  });

  it("renames only captured A and its source default while the real rename parent lock waits across a Home switch", async () => {
    const f = await fixture();
    const entryA = await seedLinkedDefaults(f);
    const workspaceA = await resolveProjectWorkspaceInHome(f.rootA, f.homeA);
    await withCanvasMapLayoutDiskLocks([workspaceA], "test-rename-fixture", async () => {});
    f.beforeA = await tree(f.homeA);
    const nextName = "Renamed Home Lifecycle Import";
    const nextId = createManagedProjectId(nextName);
    const nextRoot = join(f.homeA, "projects", nextId);
    const defaultsBefore = JSON.parse(
      await readFile(join(f.homeA, "source-defaults.json"), "utf8")
    );
    const barrier = await hold((operation) => withProjectMutationLock(f.rootA, operation));
    const lockRequested = watchProjectLockRequest("rename-project");
    const renaming = observe(renameProject(f.id, nextName));
    try {
      await bounded(lockRequested);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      barrier.release();
      const result = await bounded(renaming.outcome);
      await barrier.holding;
      await assertHomeBUnchanged(f, settingsBytes);
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value).toMatchObject({
        projectId: nextId,
        name: nextName,
        rootPath: nextRoot,
        workspaceRoot: nextRoot
      });
      expect(await optionalFiles.optionalStat(f.rootA)).toBeNull();
      expect(JSON.parse(await readFile(join(nextRoot, "project.json"), "utf8"))).toMatchObject({
        id: nextId,
        name: nextName,
        rootPath: nextRoot,
        sourceRoot: entryA.sourceRoot
      });
      const defaultsAfter = JSON.parse(
        await readFile(join(f.homeA, "source-defaults.json"), "utf8")
      );
      expect(defaultsAfter).toEqual({
        ...defaultsBefore,
        defaults: {
          ...defaultsBefore.defaults,
          [entryA.sourceRoot]: {
            ...entryA,
            projectId: nextId,
            projectRoot: nextRoot,
            updatedAt: expect.any(String)
          }
        }
      });
      const afterA = await tree(f.homeA);
      for (const [path, bytes] of Object.entries(f.beforeA)) {
        if (path.startsWith(`projects/${f.id}/canvases/`)) {
          const nextPath = path.replace(`projects/${f.id}/`, `projects/${nextId}/`);
          if (path.endsWith("/package/manifest.json")) {
            const previousManifest = JSON.parse(Buffer.from(bytes, "base64").toString("utf8"));
            expect(JSON.parse(await readFile(join(f.homeA, nextPath), "utf8"))).toEqual({
              ...previousManifest,
              project: { ...previousManifest.project, title: nextName }
            });
          } else {
            expect(afterA[nextPath]).toBe(bytes);
          }
        }
      }
      const unrelatedBefore = withoutProject(f.beforeA, f.id);
      const unrelatedAfter = withoutProject(afterA, nextId);
      delete unrelatedBefore["source-defaults.json"];
      delete unrelatedAfter["source-defaults.json"];
      expect(unrelatedAfter).toEqual(unrelatedBefore);
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, renaming.outcome]);
    }
  });

  it("sets a source default only in A when settings switch after A metadata admission reads real storage", async () => {
    const f = await fixture();
    const entryA = await seedLinkedDefaults(f);
    const previous = await initManagedWorkspace({
      name: "Previous Source Default",
      projectGraph: true
    });
    await linkProjectSourceRoot(previous.project.id, f.sourceRoot);
    await setSourceDefaultProject(f.sourceRoot, previous.project.id);
    f.beforeA = await tree(f.homeA);
    const metadataRead = deferred();
    const resumeRead = deferred();
    const realStat = optionalFiles.optionalStat;
    vi.spyOn(optionalFiles, "optionalStat").mockImplementation(async (path) => {
      const value = await realStat(path);
      if (path === join(f.rootA, "project.json")) {
        metadataRead.resolve();
        await resumeRead.promise;
      }
      return value;
    });
    const setting = observe(setSourceDefaultProject(f.sourceRoot, f.id));
    try {
      await bounded(metadataRead.promise);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      const settingsBytes = await readFile(f.settingsFile, "utf8");
      resumeRead.resolve();
      const result = await bounded(setting.outcome);
      await assertHomeBUnchanged(f, settingsBytes);
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value).toMatchObject({
        projectId: f.id,
        projectRoot: f.rootA,
        sourceRoot: entryA.sourceRoot
      });
      expect(JSON.parse(await readFile(join(f.homeA, "source-defaults.json"), "utf8"))).toEqual({
        version: "planweave-source-defaults/v1",
        defaults: { [entryA.sourceRoot]: result.value }
      });
      const afterA = await tree(f.homeA);
      delete afterA["source-defaults.json"];
      const beforeA = { ...f.beforeA };
      delete beforeA["source-defaults.json"];
      expect(afterA).toEqual(beforeA);
    } finally {
      resumeRead.resolve();
      await Promise.allSettled([setting.outcome]);
    }
  });
});
