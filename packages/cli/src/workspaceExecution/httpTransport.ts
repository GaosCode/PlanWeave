import { WorkspaceExecutionCliError } from "./errors.js";
import type { WorkspaceExecutionFailureKind } from "@planweave-ai/runtime";

export const WORKSPACE_HTTP_TIMEOUT_MS = 15_000;

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export type WorkspaceJsonRequestOptions = {
  body?: unknown;
  rawBody?: string;
  signal?: AbortSignal;
  accept?: string;
  contentType?: string;
};

export type WorkspaceBytesResponse = {
  headers: Headers;
  body: Uint8Array;
};

export type WorkspaceJsonTransport = {
  json<T>(
    method: "GET" | "POST",
    path: string,
    schema: RuntimeSchema<T>,
    options?: WorkspaceJsonRequestOptions
  ): Promise<T>;
  bytes(
    method: "GET" | "POST",
    path: string,
    options?: WorkspaceJsonRequestOptions & { maxBytes?: number }
  ): Promise<WorkspaceBytesResponse>;
};

function serverErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.error !== "string") return undefined;
  return /^[a-z][a-z0-9_]{0,127}$/.test(record.error) ? record.error : undefined;
}

function httpFailureKind(status: number): WorkspaceExecutionFailureKind {
  if (status === 400) return "usage";
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "execution";
}

function httpError(status: number, domainCode?: string): WorkspaceExecutionCliError {
  const failureKind = httpFailureKind(status);
  if (
    domainCode === "remote_interaction_not_found" ||
    domainCode === "remote_interaction_expired" ||
    domainCode === "remote_interaction_already_settled"
  ) {
    return new WorkspaceExecutionCliError(domainCode, 7, false, undefined, failureKind);
  }
  if (status === 400) {
    return new WorkspaceExecutionCliError(
      domainCode ?? "workspace_execution_usage_invalid",
      2,
      false,
      undefined,
      failureKind
    );
  }
  if (status === 401) {
    return new WorkspaceExecutionCliError(
      domainCode ?? "workspace_http_unauthorized",
      4,
      false,
      undefined,
      failureKind
    );
  }
  if (status === 403) {
    return new WorkspaceExecutionCliError(
      domainCode ?? "workspace_http_forbidden",
      5,
      false,
      undefined,
      failureKind
    );
  }
  if (status === 404) {
    return new WorkspaceExecutionCliError(
      domainCode ?? "workspace_http_not_found",
      5,
      false,
      undefined,
      failureKind
    );
  }
  if (status === 409 || status === 412) {
    return new WorkspaceExecutionCliError(
      domainCode ?? "workspace_http_conflict",
      5,
      false,
      undefined,
      failureKind
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return new WorkspaceExecutionCliError(
      domainCode ?? "workspace_http_unavailable",
      9,
      true,
      undefined,
      failureKind
    );
  }
  return new WorkspaceExecutionCliError(
    domainCode ?? "workspace_http_unavailable",
    8,
    false,
    undefined,
    failureKind
  );
}

function observeCancellation(pending: Promise<unknown>): void {
  // Cancellation can reject after the request has settled; it is cleanup, not a new result.
  void pending.catch(() => undefined);
}

async function readBody(
  response: Response,
  signal: AbortSignal,
  maxBytes?: number
): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => observeCancellation(reader.cancel(signal.reason));
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (maxBytes !== undefined && length > maxBytes) {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    complete = true;
    return body;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete && !signal.aborted) observeCancellation(reader.cancel());
    reader.releaseLock();
  }
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBody(response, signal)));
}

async function responseErrorCode(
  response: Response,
  signal: AbortSignal
): Promise<string | undefined> {
  try {
    return serverErrorCode(await responseJson(response, signal));
  } catch {
    signal.throwIfAborted();
    // An unreadable error envelope retains the status-based HTTP classification.
    return undefined;
  }
}

async function consumeWithDeadline<T>(input: {
  request: typeof fetch;
  url: URL;
  init: RequestInit;
  callerSignal?: AbortSignal;
  timeoutMs: number;
  consume(response: Response, signal: AbortSignal): Promise<T>;
}): Promise<T> {
  if (input.callerSignal?.aborted) {
    throw input.callerSignal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const controller = new AbortController();
  const onCallerAbort = () =>
    controller.abort(input.callerSignal?.reason ?? new DOMException("Aborted", "AbortError"));
  input.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timeoutFailure = new WorkspaceExecutionCliError(
    "workspace_http_unavailable",
    9,
    true,
    undefined,
    "unavailable"
  );
  let rejectAbort!: (reason: unknown) => void;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(timeoutFailure), input.timeoutMs);
  const operation = (async () => {
    let response: Response;
    try {
      response = await input.request(input.url, { ...input.init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof WorkspaceExecutionCliError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new WorkspaceExecutionCliError(
        "workspace_http_unavailable",
        9,
        true,
        { cause: error },
        "unavailable"
      );
    }
    if (controller.signal.aborted) {
      if (response.body) observeCancellation(response.body.cancel(controller.signal.reason));
      throw controller.signal.reason;
    }
    try {
      return await input.consume(response, controller.signal);
    } finally {
      // Synchronous parsing cannot be interrupted, but a result past the deadline must fail.
      if (performance.now() - startedAt >= input.timeoutMs) controller.abort(timeoutFailure);
      controller.signal.throwIfAborted();
    }
  })();
  try {
    // The race observes late request/body rejection even when an injected fetch ignores abort.
    return await Promise.race([interruption, operation]);
  } finally {
    clearTimeout(timeout);
    input.callerSignal?.removeEventListener("abort", onCallerAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export function createWorkspaceJsonTransport(input: {
  serverOrigin: string;
  credential: string;
  identityCredential?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): WorkspaceJsonTransport {
  const request = input.fetch ?? fetch;

  async function send<T>(
    method: "GET" | "POST",
    path: string,
    options: WorkspaceJsonRequestOptions,
    consume: (response: Response, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (options.body !== undefined && options.rawBody !== undefined) {
      throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
    }
    const body =
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.credential}`,
      accept: options.accept ?? "application/json"
    };
    if (input.identityCredential) {
      headers["x-planweave-human-identity"] = `Bearer ${input.identityCredential}`;
    }
    if (body !== undefined) {
      const contentType =
        options.contentType ?? (options.rawBody === undefined ? "application/json" : undefined);
      if (!contentType) {
        throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
      }
      headers["content-type"] = contentType;
    }
    return consumeWithDeadline({
      request,
      url: new URL(path, input.serverOrigin),
      callerSignal: options.signal,
      timeoutMs: input.timeoutMs ?? WORKSPACE_HTTP_TIMEOUT_MS,
      init: { method, headers, ...(body === undefined ? {} : { body }) },
      consume
    });
  }

  return {
    async json(method, path, schema, options = {}) {
      return send(method, path, options, async (response, signal) => {
        if (!response.ok)
          throw httpError(response.status, await responseErrorCode(response, signal));
        let payload: unknown;
        try {
          payload = await responseJson(response, signal);
        } catch (error) {
          signal.throwIfAborted();
          throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true, {
            cause: error
          });
        }
        const parsed = schema.safeParse(payload);
        signal.throwIfAborted();
        if (!parsed.success) {
          throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
        }
        return parsed.data;
      });
    },
    async bytes(method, path, options = {}) {
      return send(method, path, options, async (response, signal) => {
        if (!response.ok)
          throw httpError(response.status, await responseErrorCode(response, signal));
        try {
          const body = await readBody(response, signal, options.maxBytes);
          if (options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
            throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
          }
          return { headers: response.headers, body };
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof WorkspaceExecutionCliError) throw error;
          throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true, {
            cause: error
          });
        }
      });
    }
  };
}
