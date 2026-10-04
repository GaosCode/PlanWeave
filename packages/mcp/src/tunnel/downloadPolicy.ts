export const tunnelDownloadLimits = {
  deadlineMs: 120_000,
  metadataBytes: 2 * 1024 * 1024,
  checksumBytes: 1024 * 1024,
  zipBytes: 128 * 1024 * 1024,
  binaryBytes: 256 * 1024 * 1024,
  entries: 256
};

export class TunnelDownloadError extends Error {
  constructor(
    readonly code: "timeout" | "size_limit" | "invalid_archive" | "checksum_mismatch",
    message: string
  ) {
    super(message);
    this.name = "TunnelDownloadError";
  }
}
