import { TunnelDownloadError, tunnelDownloadLimits } from "./downloadPolicy.js";

export class TunnelDownloadOperation {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly deadlineAt = performance.now() + tunnelDownloadLimits.deadlineMs;
  private readonly timer = setTimeout(
    () =>
      this.controller.abort(
        new TunnelDownloadError(
          "timeout",
          "Tunnel client download exceeded its operation deadline."
        )
      ),
    tunnelDownloadLimits.deadlineMs
  );

  check(): void {
    if (!this.signal.aborted && performance.now() >= this.deadlineAt) {
      this.abort(
        new TunnelDownloadError(
          "timeout",
          "Tunnel client download exceeded its operation deadline."
        )
      );
    }
    this.signal.throwIfAborted();
  }
  close(): void {
    clearTimeout(this.timer);
  }
  abort(error: unknown): void {
    this.controller.abort(error);
  }

  wait<T>(promise: Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", aborted, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => this.signal.removeEventListener("abort", aborted));
    });
  }

  async bytes(
    url: string,
    label: string,
    limit: number,
    headers?: HeadersInit
  ): Promise<Uint8Array> {
    this.check();
    const request = fetch(url, { signal: this.signal, headers });
    // A late transport response must not retain a body after the operation ends.
    request.then(
      (response) => {
        if (this.signal.aborted && response.body) {
          void response.body
            .cancel(this.signal.reason)
            .catch((error: unknown) => this.abort(error));
        }
      },
      () => undefined
    );
    const response = await this.wait(request);
    if (!response.ok) {
      const error = new Error(`Failed to download ${label}: ${response.status}.`);
      this.abort(error);
      if (response.body) {
        void response.body.cancel(error).catch((cleanupError: unknown) => this.abort(cleanupError));
      }
      throw error;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`Tunnel client ${label} response has no body.`);
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (!cancellation) {
        cancellation = reader.cancel(this.signal.reason);
        void cancellation.catch((error: unknown) => this.abort(error));
      }
    };
    this.signal.addEventListener("abort", cancel, { once: true });
    let complete = false;
    try {
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) > limit) {
        throw new TunnelDownloadError(
          "size_limit",
          `Tunnel client ${label} exceeds the byte limit (${limit}).`
        );
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        this.check();
        const { done, value } = await this.wait(reader.read());
        if (done) {
          complete = true;
          break;
        }
        size += value.byteLength;
        if (size > limit)
          throw new TunnelDownloadError(
            "size_limit",
            `Tunnel client ${label} exceeds the byte limit (${limit}).`
          );
        chunks.push(value);
      }
      this.check();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      this.abort(error);
      throw error;
    } finally {
      this.signal.removeEventListener("abort", cancel);
      // Cancellation closes the reader synchronously; a transport cleanup promise must not extend the deadline.
      if (!complete) cancel();
      reader.releaseLock();
    }
  }
}
