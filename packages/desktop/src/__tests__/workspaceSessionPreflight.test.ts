import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { buildLiveCollaborationProfile } from "../main/collaboration/liveServerBinding.js";
import {
  configureWorkspaceAccess,
  deviceToken,
  issueDeviceSetupCode,
  redeemDesktop,
  setupSelfHostedTwoClientFixture
} from "./support/selfHostedTwoClientE2E.js";

it("preflights a shared canvas using a redeemed Workspace member credential", async () => {
  const fixture = await setupSelfHostedTwoClientFixture();
  const join = async (name: string) =>
    redeemDesktop({
      home: fixture.home,
      name,
      origin: fixture.origin,
      setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
    });
  const owner = await join("Owner");
  const member = await join("Member");
  const ownerSelf = await owner.connection.getSelf();
  const memberSelf = await member.connection.getSelf();
  const configured = await configureWorkspaceAccess({
    databasePath: fixture.databasePath,
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    ownerId: ownerSelf.humanPrincipalId,
    memberId: memberSelf.humanPrincipalId
  });
  let token = await deviceToken(member);
  const client = new CollaborationClient({
    profile: buildLiveCollaborationProfile({
      profileId: "workspace-member",
      displayName: "Member",
      serverBaseUrl: `${fixture.origin}/`,
      allowInsecureTransport: true,
      projectId: fixture.projectId
    }),
    credential: { getDeviceToken: async () => token }
  });
  try {
    await expect(client.verifyAccess()).resolves.toBeUndefined();
    const socket = new WebSocket(
      `${fixture.origin.replace("http:", "ws:")}/api/v1/projects/${encodeURIComponent(fixture.projectId)}/human/observe`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    try {
      const message = await new Promise<string>((resolve, reject) => {
        socket.once("open", () =>
          socket.send(
            JSON.stringify({
              type: "human.observer.hello",
              protocolVersion: 1,
              projectId: fixture.projectId,
              lastCursor: 0
            })
          )
        );
        socket.once("message", (data) => resolve(data.toString()));
        socket.once("error", reject);
      });
      expect(JSON.parse(message)).toMatchObject({ type: "human.observer.welcome" });
    } finally {
      socket.terminate();
    }
    const page = await client.registry().listCanvases({ projectId: fixture.projectId });
    expect(page.items.map((item) => item.registry.canvasId)).toContain("default");
    expect(page.items.map((item) => item.registry.canvasId)).not.toContain("private");
    token = `pw_hdev_${"Z".repeat(43)}`;
    await expect(client.verifyAccess()).rejects.toMatchObject({ kind: "auth" });
  } finally {
    client.dispose();
    configured.database.close();
  }
});
