import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { accessCapabilityFlags } from "@planweave-ai/collaboration-protocol/access/control";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  CollaborationCredentialVault,
  CollaborationProfileStore,
  CollaborationService,
  WorkspaceConnectionProfileStore
} from "../main/collaboration/index.js";

type ReadKind = "members" | "self" | "picker" | "access";

function read(service: CollaborationService, kind: ReadKind) {
  switch (kind) {
    case "members":
      return service.listWorkspaceConnectionMembers();
    case "self":
      return service.getWorkspaceConnectionSelf();
    case "picker":
      return service.listWorkspacePicker();
    case "access":
      return service.getCurrentCanvasAccess({ projectId: "project-a", canvasId: "default" });
  }
}

function response(url: URL, pickerDisplayName?: string): Response {
  const workspaceId = url.hostname === "a.example" ? "workspace-a" : "workspace-b";
  if (url.pathname.endsWith("/access")) {
    const scope = { scopeKind: "canvas", workspaceId, projectId: "project-a", canvasId: "default" };
    const grant = {
      effectiveRole: "owner",
      roleSource: "scope_owner",
      capabilities: accessCapabilityFlags("owner"),
      disabledReason: null
    };
    return Response.json({
      scope,
      projectVisibility: "private",
      canvasVisibility: "shared",
      projectAclRevision: 1,
      canvasAclRevision: 1,
      project: {
        ...grant,
        scope: { ...scope, scopeKind: "project", canvasId: null },
        aclRevision: 1
      },
      canvas: { ...grant, scope, aclRevision: 1 },
      people: []
    });
  }
  if (url.pathname.endsWith("/self"))
    return Response.json({
      schemaVersion: "workspace-setup/v1",
      workspaceId,
      membershipId: `member-${workspaceId}`,
      humanPrincipalId: `human-${workspaceId}`,
      displayName: workspaceId,
      role: "owner",
      deviceSessionId: `device-${workspaceId}`
    });
  if (url.pathname.endsWith("/members"))
    return Response.json({
      schemaVersion: "workspace-setup/v1",
      items: [
        {
          schemaVersion: "workspace-setup/v1",
          membershipId: `member-${workspaceId}`,
          humanPrincipalId: `human-${workspaceId}`,
          displayName: workspaceId,
          role: "owner",
          devices: []
        }
      ],
      nextCursor: null
    });
  if (url.pathname === "/api/v1/registry/projects")
    return Response.json({ items: [], nextCursor: null });
  expect(url.pathname).toBe("/api/v1/workspace-connection");
  return Response.json({
    schemaVersion: "workspace-setup/v1",
    items: [
      {
        schemaVersion: "workspace-setup/v1",
        workspaceId,
        displayName: pickerDisplayName ?? workspaceId,
        role: "owner",
        archivedAt: null,
        membershipActive: true
      }
    ],
    nextCursor: null
  });
}

const cases = (["members", "self", "picker", "access"] as const).flatMap((kind) =>
  (["resolve", "reject"] as const).map((completion) => ({
    kind,
    completion,
    action: "switch" as const
  }))
);

it.each([
  ...cases,
  ...(["latest", "aba", "rotate", "clear"] as const).map((action) => ({
    kind: "picker" as const,
    completion: "resolve" as const,
    action
  }))
])("retires a held $kind read that can $completion during $action", async ({
  kind,
  completion,
  action
}) => {
  const root = await mkdtemp(join(tmpdir(), "pw-workspace-read-lifecycle-"));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  };
  const workspaceProfiles = new WorkspaceConnectionProfileStore({
    profilesPath: join(root, "workspaces.json")
  });
  const vault = new CollaborationCredentialVault({
    paths: { credentialsPath: join(root, "credentials.json") },
    safeStorage
  });
  for (const suffix of ["a", "b"]) {
    await workspaceProfiles.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: `profile-${suffix}`,
        displayName: suffix,
        serverBaseUrl: `https://${suffix}.example/`,
        workspaceId: `workspace-${suffix}`,
        allowInsecureTransport: false
      },
      workspaceDisplayName: suffix,
      membershipRole: "owner",
      membershipActive: true
    });
    await vault.setDeviceToken(`profile-${suffix}`, exampleHumanDeviceToken, {
      humanPrincipalId: `human-workspace-${suffix}`,
      deviceCredentialId: `device-workspace-${suffix}`
    });
  }
  await workspaceProfiles.setActiveProfileId("profile-a");
  let pickerDisplayName = "initial directory";
  let armed = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = new CollaborationService({
    workspaceProfileStore: workspaceProfiles,
    vault,
    safeStorage,
    profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
    invitationsPath: join(root, "invitations.json"),
    exportedIdentityPath: join(root, "exported.json"),
    request: async (input) => {
      const url = new URL(String(input));
      const result = response(url, pickerDisplayName);
      const selected =
        kind === "picker"
          ? url.pathname === "/api/v1/workspace-connection"
          : url.pathname.endsWith(`/${kind}`);
      if (armed && selected && url.hostname === "a.example") {
        armed = false;
        started();
        await barrier;
        if (completion === "reject") throw new TypeError("retired read transport failed");
      }
      return result;
    }
  });
  let oldRead: Promise<unknown> | undefined;
  let switched: Promise<unknown> | undefined;
  try {
    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "A",
      serverBaseUrl: "https://a.example/",
      projectId: "project-a",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://a.example/",
        allowedClientOrigins: ["https://a.example/"],
        tlsTrust: "system_ca"
      }
    });
    await service.connectWorkspaceConnection();
    const initialPicker = (await service.getStatus()).workspacePicker;
    pickerDisplayName = "retired directory";
    armed = true;
    oldRead = read(service, kind).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error })
    );
    await entered;
    pickerDisplayName = "current directory";
    let completed = false;
    switched = (async () => {
      switch (action) {
        case "switch":
          return service.selectWorkspaceConnection({ profileId: "profile-b" });
        case "aba":
          await service.selectWorkspaceConnection({ profileId: "profile-b" });
          return service.selectWorkspaceConnection({ profileId: "profile-a" });
        case "rotate":
          return service.importDeviceCredential({
            profileId: "profile-a",
            deviceToken: exampleHumanDeviceToken,
            humanPrincipalId: "replacement-human"
          });
        case "clear":
          return service.clearDeviceCredential({ profileId: "profile-a" });
        case "latest":
          return service.listWorkspacePicker();
      }
    })().then((result) => {
      completed = true;
      return result;
    });
    await expect.poll(() => completed, { timeout: 1000 }).toBe(true);
    const workspaceId = action === "switch" ? "workspace-b" : "workspace-a";
    expect((await service.getActiveWorkspaceConnection()).workspaceId).toBe(workspaceId);
    if (action !== "clear") {
      const fresh = await read(service, kind === "access" ? "members" : kind);
      expect(JSON.stringify(fresh)).toContain(workspaceId);
    }
    const expectedPicker =
      action === "clear" ? initialPicker : (await service.getStatus()).workspacePicker;
    release();
    const old = await oldRead;
    expect(old).toMatchObject({ ok: completion === "resolve" });
    expect((await service.getStatus()).workspacePicker).toEqual(expectedPicker);
    expect((await service.getActiveWorkspaceConnection()).workspaceId).toBe(workspaceId);
  } finally {
    release();
    await Promise.allSettled([oldRead, switched]);
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
