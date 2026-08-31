export const remoteRunnerEventV2Capability = {
  available: true as const,
  acceptedVersions: [2] as const,
  preferredVersion: 2 as const,
  v1Accepted: 0,
  v2Accepted: 0,
  v1Degraded: 0,
  usageSnapshotsAccepted: 0,
  usageSnapshotRegressions: 0
};

export const remoteRunnerEventV2Request: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
  if (url.pathname !== "/version") return await fetch(input, init);
  return new Response(JSON.stringify({ remoteRunnerEvents: remoteRunnerEventV2Capability }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
