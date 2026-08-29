import type { RuntimeContext } from "./runtimeContext.js";
import {
  remoteBlockSourceSnapshot,
  remoteDispatchAuthoritativeDependencies
} from "./remoteBlockSourceSnapshot.js";

export { remoteDispatchAuthoritativeDependencies };

export type RemoteBlockSourceEvidence = {
  sourceRevision: string;
  graphFingerprint: string;
};

export function sameRemoteBlockSource(
  left: RemoteBlockSourceEvidence,
  right: RemoteBlockSourceEvidence
): boolean {
  return (
    left.sourceRevision === right.sourceRevision && left.graphFingerprint === right.graphFingerprint
  );
}

export function sameRemoteBlockAuthority(
  current: RemoteBlockSourceEvidence,
  requested: RemoteBlockSourceEvidence
): boolean {
  if (requested.sourceRevision.startsWith("snapshot:")) {
    return current.graphFingerprint === requested.graphFingerprint;
  }
  return sameRemoteBlockSource(current, requested);
}

/**
 * Fingerprint package inputs plus the dependency generations consumed by a dispatch.
 * Target status is intentionally excluded so preparation/activation do not invalidate it.
 */
export async function remoteBlockSourceEvidence(
  context: RuntimeContext,
  ref: string
): Promise<RemoteBlockSourceEvidence> {
  const snapshot = await remoteBlockSourceSnapshot(context, ref);
  return {
    sourceRevision: snapshot.sourceRevision,
    graphFingerprint: snapshot.graphFingerprint
  };
}
