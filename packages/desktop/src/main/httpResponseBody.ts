/** Cancellation is best-effort cleanup: it must not delay the request's terminal result. */
export function cancelHttpBody(
  owner: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown
): void {
  try {
    void owner.cancel(reason).catch(() => {
      // Preserve the primary failure without logging body or credential data.
      console.warn("HTTP response body cancellation failed.");
    });
  } catch {
    console.warn("HTTP response body cancellation failed.");
  }
}

/** Reject before retaining an over-budget chunk, including bodies without a trustworthy length. */
export async function readHttpResponseBytes(
  response: Response,
  maxBytes: number,
  tooLarge: () => Error
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    const error = tooLarge();
    if (response.body) cancelHttpBody(response.body, error);
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) throw tooLarge();
      totalBytes += value.byteLength;
      chunks.push(value);
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    cancelHttpBody(reader, error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
