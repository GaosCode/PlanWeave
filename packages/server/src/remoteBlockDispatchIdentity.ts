import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { HumanPrincipalIdentity } from "./identity/humanPrincipalIdentity.js";

export function parseDispatchCaller(callerHumanPrincipalId: string): string {
  return humanPrincipalIdSchema.parse(callerHumanPrincipalId);
}

export function canonicalizeDispatchCaller(
  identity: HumanPrincipalIdentity,
  callerHumanPrincipalId: string
): string {
  return identity.canonicalizeTarget(parseDispatchCaller(callerHumanPrincipalId));
}

export function sameDispatchCaller(
  identity: HumanPrincipalIdentity,
  originalCaller: string,
  incomingCaller: string
): boolean {
  return identity.areEquivalent(originalCaller, incomingCaller);
}
