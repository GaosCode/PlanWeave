import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthoritativeContentHead,
  AuthoritativeContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { captureAuthorizedCanvasContent } from "../../../runtime/src/desktop/authorizedCanvasContent.js";
import { initManagedWorkspace } from "../../../runtime/src/initWorkspace.js";
import { createManagedProjectId } from "../../../runtime/src/projectId.js";
import { DesktopSettingsStore } from "../main/desktopSettingsStore.js";
import {
  CollaborationClient,
  type CollaborationClientOptions,
  type CollaborationObserverHandlers
} from "../main/collaboration/CollaborationClient.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";
import { deferred } from "./helpers/desktopProjectFixtures.js";

vi.mock("@planweave-ai/runtime", () => import("../../../runtime/src/index.js"));

const originalHome = process.env.PLANWEAVE_HOME;
const originalSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
const directories: string[] = [];
const services: CollaborationService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettings;
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function treeBytes(root: string, prefix = ""): Promise<Record<string, string>> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory())
      Object.assign(files, await treeBytes(join(root, entry.name), relative));
    else files[relative] = (await readFile(join(root, entry.name))).toString("base64");
  }
  return files;
}

class DownloadClient extends CollaborationClient {
  constructor(
    options: CollaborationClientOptions,
    private readonly head: () => Promise<AuthoritativeContentHead>,
    private readonly content: AuthoritativeContentVersion
  ) {
    super(options);
  }

  override async verifyAccess(): Promise<void> {}

  override startObserver(handlers: CollaborationObserverHandlers = {}): void {
    handlers.onStatus?.({ state: "connected", cursor: 0 });
  }

  override fetchContentHead(): Promise<AuthoritativeContentHead> {
    return this.head();
  }

  override async fetchContentVersion(): Promise<AuthoritativeContentVersion> {
    return this.content;
  }
}

describe("CollaborationService queued download Home ownership", () => {
  it.each([
    { firstFails: false, conflictingHomeB: false },
    { firstFails: true, conflictingHomeB: false },
    { firstFails: false, conflictingHomeB: true }
  ])("keeps the queued fork in its invocation Home: %j", async ({
    firstFails,
    conflictingHomeB
  }) => {
    const source = await createTestWorkspace();
    const homeA = source.home;
    const homeB = await mkdtemp(join(tmpdir(), "planweave-queued-download-B-"));
    directories.push(source.home, source.root, homeB);
    const settings = new DesktopSettingsStore({
      settingsFile: join(homeA, "desktop-settings.json"),
      planweaveHomeBaseline: homeA
    });
    const projectName = "Queued Download";
    const id = createManagedProjectId(projectName);
    if (conflictingHomeB) {
      await initManagedWorkspace({ name: projectName, planweaveHome: homeB });
    }
    await settings.mergePatch({ planweaveHome: homeA });
    const homeBBytes = await treeBytes(homeB);
    const { content } = await captureAuthorizedCanvasContent({
      projectRoot: source.init.workspace
    });
    const scope = {
      workspaceId: "workspace-download",
      projectId: source.init.workspace.id,
      canvasId: "canvas-download"
    };
    const completed = {
      versionId: `version-${content.canonicalDigest}`,
      canonicalDigest: content.canonicalDigest,
      verification: "complete" as const
    };
    const entered = deferred<void>();
    const release = deferred<void>();
    let heads = 0;
    const head = async (): Promise<AuthoritativeContentHead> => {
      heads += 1;
      if (heads === 1) {
        entered.resolve();
        await release.promise;
        if (firstFails) throw new Error("first_download_failed");
      }
      return {
        schemaVersion: "content-version/v1",
        scope,
        revision: 3,
        content: completed,
        advancedAt: "2026-08-01T00:00:00.000Z"
      };
    };
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(homeA, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(homeA, "credentials.json") },
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (value) => Buffer.from(value),
          decryptString: (value) => value.toString()
        }
      }),
      invitationsPath: join(homeA, "invitations.json"),
      workspaceProfileStorePaths: { profilesPath: join(homeA, "workspace-profiles.json") },
      exportedIdentityPath: join(homeA, "identity.json"),
      createClient: (options) =>
        new DownloadClient(options, head, {
          schemaVersion: "content-version/v1",
          scope,
          completed,
          content,
          createdAt: "2026-08-01T00:00:00.000Z",
          createdBy: { kind: "human", id: "source-owner" }
        })
    });
    services.push(service);
    await service.upsertProfile({
      profileId: "profile-download",
      displayName: "Download",
      serverBaseUrl: "https://download.example.test/",
      projectId: scope.projectId,
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://download.example.test/",
        allowedClientOrigins: ["https://download.example.test/"],
        tlsTrust: "system_ca"
      }
    });
    await service.importDeviceCredential({
      profileId: "profile-download",
      deviceToken: exampleHumanDeviceToken
    });
    await service.connectSession({ profileId: "profile-download" });
    const first = service.downloadWorkspaceCanvasFork({ ...scope, projectName: "First Download" });
    const firstOutcome = Promise.allSettled([first]);
    await entered.promise;
    const second = service.downloadWorkspaceCanvasFork({ ...scope, projectName });
    const secondOutcome = Promise.allSettled([second]);
    try {
      expect(heads).toBe(1);
      await settings.mergePatch({ planweaveHome: homeB });
      const settingsBytes = await readFile(settings.settingsFile, "utf8");
      release.resolve();
      const [firstResult] = await firstOutcome;
      expect(firstResult.status).toBe(firstFails ? "rejected" : "fulfilled");
      if (firstResult.status === "rejected")
        expect(firstResult.reason.message).toBe("first_download_failed");
      const [secondResult] = await secondOutcome;
      expect(secondResult.status).toBe("fulfilled");
      if (secondResult.status !== "fulfilled") throw secondResult.reason;
      expect(secondResult.value).toMatchObject({
        localProjectId: id,
        localCanvasId: "default",
        writeback: false
      });
      const rootA = join(homeA, "projects", id);
      expect(JSON.parse(await readFile(join(rootA, "project.json"), "utf8"))).toMatchObject({
        name: projectName
      });
      expect(
        JSON.parse(await readFile(join(rootA, "workspace-fork-lineage.json"), "utf8"))
      ).toEqual(secondResult.value.lineage);
      for (const member of content.members.filter((member) => member.kind !== "desktop_layout")) {
        expect(
          await readFile(join(rootA, "canvases", "default", "package", member.path), "utf8")
        ).toBe(member.content);
      }
      expect(await treeBytes(homeB)).toEqual(homeBBytes);
      expect(await readFile(settings.settingsFile, "utf8")).toBe(settingsBytes);
      expect(process.env.PLANWEAVE_HOME).toBe(homeB);
    } finally {
      release.resolve();
      await Promise.all([firstOutcome, secondOutcome]);
    }
  });
});
