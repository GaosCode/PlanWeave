/* helpers shared by CollaborationConnectForm tests */

import { vi } from "vitest";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

export function joinApi() {
  return {
    upsertCollaborationProfile: vi.fn().mockResolvedValue(undefined),
    consumeCollaborationInvitation: vi.fn().mockResolvedValue({
      deviceCredentialPersistence: "persisted",
      nonPersistenceWarning: null
    }),
    redeemCollaborationSetupCode: vi.fn().mockResolvedValue(undefined),
    connectCollaborationSession: vi.fn().mockResolvedValue(undefined)
  } as unknown as PlanWeaveCollaborationApi;
}

export function setupApi() {
  return {
    redeemCollaborationSetupCode: vi.fn().mockResolvedValue(undefined)
  } as unknown as PlanWeaveCollaborationApi;
}
