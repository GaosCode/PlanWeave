import { describe, expect, it } from "vitest";
import {
  assertFixturesDoNotShareAcceptanceState,
  configureWorkspaceAccess,
  deviceToken,
  discoverContentHead,
  issueDeviceSetupCode,
  redeemDesktop,
  setupSelfHostedTwoClientFixture
} from "./support/selfHostedTwoClientE2E.js";

async function ownerSession(fixture: Awaited<ReturnType<typeof setupSelfHostedTwoClientFixture>>) {
  const owner = await redeemDesktop({
    home: fixture.home,
    name: "Publish Owner",
    origin: fixture.origin,
    setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
  });
  const member = await redeemDesktop({
    home: fixture.home,
    name: "Publish Member",
    origin: fixture.origin,
    setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
  });
  const ownerToken = await deviceToken(owner);
  const ownerId = owner.view.profile?.profileId;
  const memberId = member.view.profile?.profileId;
  const ownerCredential = await owner.vault.getMetadata(ownerId ?? "");
  const memberCredential = await member.vault.getMetadata(memberId ?? "");
  if (!ownerCredential?.humanPrincipalId || !memberCredential?.humanPrincipalId) {
    throw new Error("workspace_principal_missing");
  }
  const configured = await configureWorkspaceAccess({
    databasePath: fixture.databasePath,
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    ownerId: ownerCredential.humanPrincipalId,
    memberId: memberCredential.humanPrincipalId
  });
  return { ownerToken, configured };
}

describe("self-hosted content head isolation", () => {
  it("does not share database, workspace, project, or canvas head across fixtures", async () => {
    const first = await setupSelfHostedTwoClientFixture();
    const second = await setupSelfHostedTwoClientFixture();
    assertFixturesDoNotShareAcceptanceState(first, second);

    const left = await ownerSession(first);
    const right = await ownerSession(second);
    try {
      const leftHead = await discoverContentHead(
        first.origin,
        first.projectId,
        "default",
        left.ownerToken
      );
      const rightHead = await discoverContentHead(
        second.origin,
        second.projectId,
        "default",
        right.ownerToken
      );
      expect(leftHead.body?.content.canonicalDigest).toBe(first.initialContent.canonicalDigest);
      expect(rightHead.body?.content.canonicalDigest).toBe(second.initialContent.canonicalDigest);
      // Distinct project scopes even when content digests match for identical fixtures.
      expect(leftHead.body).not.toEqual(rightHead.body);
    } finally {
      left.configured.database.close();
      right.configured.database.close();
    }
  });
});
