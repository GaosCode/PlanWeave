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

async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    return serverErrorCode(await response.json());
  } catch {
    return undefined;
  }
}

async function fetchWithDeadline(input: {
  request: typeof fetch;
  url: URL;
  init: RequestInit;
  callerSignal?: AbortSignal;
  timeoutMs: number;
}): Promise<Response> {
  if (input.callerSignal?.aborted) {
    throw input.callerSignal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const controller = new AbortController();
  const onCallerAbort = () => {
    controller.abort(input.callerSignal?.reason ?? new DOMException("Aborted", "AbortError"));
  };
  input.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new WorkspaceExecutionCliError(
    "workspace_http_unavailable",
    9,
    true,
    undefined,
    "unavailable"
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutFailure);
      reject(timeoutFailure);
    }, input.timeoutMs);
  });
  const callerAbort = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        if (controller.signal.reason !== timeoutFailure) {
          reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
        }
      },
      { once: true }
    );
  });
  try {
    return await Promise.race([
      input.request(input.url, { ...input.init, signal: controller.signal }),
      deadline,
      callerAbort
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    input.callerSignal?.removeEventListener("abort", onCallerAbort);
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

  async function send(
    method: "GET" | "POST",
    path: string,
    options: WorkspaceJsonRequestOptions = {}
  ): Promise<Response> {
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
    try {
      return await fetchWithDeadline({
        request,
        url: new URL(path, input.serverOrigin),
        callerSignal: options.signal,
        timeoutMs: input.timeoutMs ?? WORKSPACE_HTTP_TIMEOUT_MS,
        init: {
          method,
          headers,
          ...(body === undefined ? {} : { body })
        }
      });
    } catch (error) {
      if (error instanceof WorkspaceExecutionCliError) throw error;
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new WorkspaceExecutionCliError(
        "workspace_http_unavailable",
        9,
        true,
        { cause: error },
        "unavailable"
      );
    }
  }

  return {
    async json(method, path, schema, options = {}) {
      const response = await send(method, path, options);
      if (!response.ok) throw httpError(response.status, await responseErrorCode(response));
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true, {
          cause: error
        });
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
      }
      return parsed.data;
    },
    async bytes(method, path, options = {}) {
      const response = await send(method, path, options);
      if (!response.ok) throw httpError(response.status, await responseErrorCode(response));
      let body: Uint8Array;
      try {
        body = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true, {
          cause: error
        });
      }
      if (options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
      }
      return { headers: response.headers, body };
    }
  };
}
