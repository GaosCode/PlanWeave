export const serverPackageVersion = "0.4.0";

const revisionPattern = /^(?:[0-9a-f]{7,64}|development)$/;

export function resolveServerBuildRevision(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const revision = env.PLANWEAVE_SERVER_BUILD_REVISION?.trim() ?? "development";
  if (!revisionPattern.test(revision)) throw new Error("server_build_revision_invalid");
  return revision;
}

export const serverBuildRevision = resolveServerBuildRevision();
