import { ZodError } from "zod";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16_384;
const JSON_CONTENT_TYPE = /^application\/json(?:;\s*charset=utf-8)?$/i;

export class EnrollmentHttpError extends Error {
  constructor(
    code: "timeout" | "canceled" | "rejected" | "response_malformed" | "response_too_large"
  ) {
    super(`agent_host_enrollment_${code}`);
  }
}

async function settleBeforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, canceled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  checkDeadline: () => void
): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
    throw new EnrollmentHttpError("response_malformed");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new EnrollmentHttpError("response_malformed");
    }
    if (length > MAX_RESPONSE_BYTES) throw new EnrollmentHttpError("response_too_large");
  }
  if (!response.body) throw new EnrollmentHttpError("response_malformed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let consumed = false;
  try {
    while (true) {
      checkDeadline();
      const chunk = await settleBeforeAbort(reader.read(), signal);
      if (chunk.done) {
        consumed = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new EnrollmentHttpError("response_too_large");
      chunks.push(chunk.value);
    }
  } finally {
    // A stream source may never finish cancellation; cleanup must not hold the request open.
    if (!consumed) void Promise.allSettled([reader.cancel()]);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EnrollmentHttpError("response_malformed");
  }
}

export async function requestEnrollmentJson<T>(
  request: typeof fetch,
  endpoint: () => URL,
  input: unknown,
  parse: (response: Response, payload: unknown) => T,
  owner?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(new EnrollmentHttpError("canceled"));
  if (owner?.aborted) cancel();
  else owner?.addEventListener("abort", cancel, { once: true });
  const deadline = performance.now() + REQUEST_TIMEOUT_MS;
  const expire = () => controller.abort(new EnrollmentHttpError("timeout"));
  const timeout = setTimeout(expire, REQUEST_TIMEOUT_MS);
  const checkDeadline = () => {
    if (performance.now() >= deadline) expire();
    signal.throwIfAborted();
  };
  let response: Response | undefined;
  try {
    checkDeadline();
    const requested = request(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      redirect: "error",
      signal
    }).then((received) => {
      if (signal.aborted && received.body) void Promise.allSettled([received.body.cancel()]);
      return received;
    });
    response = await settleBeforeAbort(requested, signal);
    checkDeadline();
    const payload = await readBoundedJson(response, signal, checkDeadline);
    checkDeadline();
    const result = parse(response, payload);
    checkDeadline();
    return result;
  } catch (error) {
    if (error instanceof EnrollmentHttpError) throw error;
    if (
      error instanceof Error &&
      (error.message === "agent_host_enrollment_transport_insecure" ||
        error.message === "agent_host_enrollment_transport_unsupported")
    ) {
      throw error;
    }
    if (error instanceof ZodError) throw new EnrollmentHttpError("response_malformed");
    if (signal.aborted) throw signal.reason;
    throw new Error("agent_host_enrollment_exchange_failed");
  } finally {
    clearTimeout(timeout);
    owner?.removeEventListener("abort", cancel);
    controller.abort();
    if (response?.body && !response.bodyUsed) void Promise.allSettled([response.body.cancel()]);
  }
}
