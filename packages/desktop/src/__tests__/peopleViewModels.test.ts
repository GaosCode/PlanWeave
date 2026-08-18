import { describe, expect, it } from "vitest";
import type { HumanMembershipView } from "@planweave-ai/collaboration-protocol/identity/workspace";
import { collaborationErrorCode } from "../renderer/collaboration/formatCollaborationError";
import {
  buildPeopleHostRows,
  buildPeopleMemberRows,
  countOwners,
  deriveHostPresenceStatus,
  evaluateMemberAction,
  formatUnknownCollaborationError,
  isInvitationOpen,
  stripElectronRemoteInvokeMessage,
  memberInitials,
  resolvePeoplePanelMode
} from "../renderer/collaboration/peopleViewModels";
import type { CollaborationHostProjection } from "../shared/collaborationReadModels";

function member(
  partial: Partial<HumanMembershipView> &
    Pick<HumanMembershipView, "humanPrincipalId" | "displayName" | "role">
): HumanMembershipView {
  return {
    membershipId: partial.membershipId ?? `m-${partial.humanPrincipalId}`,
    projectId: partial.projectId ?? "project-1",
    humanPrincipalId: partial.humanPrincipalId,
    displayName: partial.displayName,
    role: partial.role,
    createdAt: partial.createdAt ?? "2030-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2030-01-01T00:00:00.000Z"
  };
}

describe("peopleViewModels", () => {
  it("derives initials and host presence from authoritative fields", () => {
    expect(memberInitials("Ada Lovelace")).toBe("AL");
    expect(memberInitials("Ada")).toBe("AD");

    const base: CollaborationHostProjection = {
      hostId: "host-1",
      projectId: "project-1",
      displayName: "Builder",
      online: true,
      revoked: false,
      authorizedForProject: true,
      exists: true,
      capabilities: ["shell"],
      capacityRemaining: 2
    };
    expect(deriveHostPresenceStatus(base)).toBe("online");
    expect(deriveHostPresenceStatus({ ...base, online: false })).toBe("offline");
    expect(deriveHostPresenceStatus({ ...base, revoked: true })).toBe("degraded");
    expect(deriveHostPresenceStatus({ ...base, authorizedForProject: false })).toBe("degraded");

    const rows = buildPeopleHostRows([base]);
    expect(rows[0]?.versionSummary).toBeNull();
    expect(rows[0]?.lastSeenSummary).toBeNull();
    expect(rows[0]?.capacityRemaining).toBe(2);
  });

  it("protects last owner on demote/remove in the view model", () => {
    const soleOwner = member({
      humanPrincipalId: "human-1",
      displayName: "Owner",
      role: "owner"
    });
    const demote = evaluateMemberAction({
      action: "demote",
      member: soleOwner,
      members: [soleOwner],
      currentUserIsOwner: true,
      currentHumanPrincipalId: "human-1"
    });
    const remove = evaluateMemberAction({
      action: "remove",
      member: soleOwner,
      members: [soleOwner],
      currentUserIsOwner: true,
      currentHumanPrincipalId: "human-1"
    });
    expect(demote).toMatchObject({ allowed: false, reason: "last_owner" });
    expect(remove).toMatchObject({ allowed: false, reason: "last_owner" });
    expect(countOwners([soleOwner])).toBe(1);

    const secondOwner = member({
      humanPrincipalId: "human-2",
      displayName: "Co-owner",
      role: "owner"
    });
    expect(
      evaluateMemberAction({
        action: "demote",
        member: soleOwner,
        members: [soleOwner, secondOwner],
        currentUserIsOwner: true,
        currentHumanPrincipalId: "human-1"
      }).allowed
    ).toBe(true);
  });

  it("disables owner actions for non-owners and builds member rows", () => {
    const owner = member({
      humanPrincipalId: "human-1",
      displayName: "Owner",
      role: "owner"
    });
    const peer = member({
      humanPrincipalId: "human-2",
      displayName: "Member",
      role: "member"
    });
    const promoteAsMember = evaluateMemberAction({
      action: "promote",
      member: peer,
      members: [owner, peer],
      currentUserIsOwner: false,
      currentHumanPrincipalId: "human-2"
    });
    expect(promoteAsMember.allowed).toBe(false);
    expect(promoteAsMember.reason).toBe("not_owner");

    const rows = buildPeopleMemberRows({
      members: [owner, peer],
      currentHumanPrincipalId: "human-1",
      currentUserIsOwner: true
    });
    expect(rows[0]?.isCurrentUser).toBe(true);
    expect(rows[1]?.actions.find((action) => action.action === "promote")?.allowed).toBe(true);
  });

  it("classifies invitation open state and panel modes", () => {
    const now = Date.parse("2030-01-02T00:00:00.000Z");
    expect(
      isInvitationOpen(
        {
          invitationId: "inv-1",
          projectId: "project-1",
          role: "member",
          createdByHumanPrincipalId: "human-1",
          createdAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-01-03T00:00:00.000Z"
        },
        now
      )
    ).toBe(true);
    expect(
      isInvitationOpen(
        {
          invitationId: "inv-2",
          projectId: "project-1",
          role: "member",
          createdByHumanPrincipalId: "human-1",
          createdAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-01-03T00:00:00.000Z",
          revokedAt: "2030-01-01T12:00:00.000Z"
        },
        now
      )
    ).toBe(false);

    expect(
      resolvePeoplePanelMode({
        status: null,
        syncPhase: "idle",
        memberCount: 0
      })
    ).toBe("disconnected");
    const connectedStatus = {
      profiles: [],
      activeProfileId: "p1",
      credentialStorage: "available" as const,
      nonPersistenceWarning: null,
      session: {
        phase: "connected" as const,
        activeProfileId: "p1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      updatedAt: "2030-01-01T00:00:00.000Z"
    };
    expect(
      resolvePeoplePanelMode({
        status: connectedStatus,
        syncPhase: "ready",
        memberCount: 2
      })
    ).toBe("ready");
    expect(
      resolvePeoplePanelMode({
        status: connectedStatus,
        syncPhase: "ready",
        memberCount: 0,
        detailsLoading: true
      })
    ).toBe("loading");
    expect(
      resolvePeoplePanelMode({
        status: connectedStatus,
        syncPhase: "ready",
        memberCount: 0,
        detailsFailed: true
      })
    ).toBe("error");
    expect(
      resolvePeoplePanelMode({
        status: connectedStatus,
        syncPhase: "ready",
        memberCount: 0
      })
    ).toBe("empty");
  });

  it("formats errors without leaking invitation or device tokens", () => {
    expect(
      formatUnknownCollaborationError({
        code: "human_last_owner_protected",
        message: "The last project owner cannot be removed or demoted."
      })
    ).toContain("human_last_owner_protected");
    expect(
      formatUnknownCollaborationError({
        code: "auth",
        message: `bad token pw_inv_${"A".repeat(43)}`
      })
    ).toBe("auth");
    expect(
      stripElectronRemoteInvokeMessage(
        "Error invoking remote method 'planweave-collaboration:listContentBootstrapCandidates': CollaborationClientError: Network request failed."
      )
    ).toBe("Network request failed.");
    expect(
      formatUnknownCollaborationError(
        new Error(
          "Error invoking remote method 'planweave-collaboration:listContentBootstrapCandidates': CollaborationClientError: Network request failed."
        )
      )
    ).toBe("Network request failed.");
    expect(
      collaborationErrorCode(
        new Error(
          "Error invoking remote method 'planweave-collaboration:connectExistingServerByOrigin': CollaborationClientError: existing_server_admission_required"
        )
      )
    ).toBe("existing_server_admission_required");
  });
});
