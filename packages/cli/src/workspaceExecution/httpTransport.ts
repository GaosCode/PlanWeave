import { WorkspaceExecutionCliError } from "./errors.js";
import type { WorkspaceExecutionFailureKind } from "@planweave-ai/runtime";

export const WORKSPACE_HTTP_TIMEOUT_MS = 15_000;

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export type WorkspaceJsonTransport = {
  json<T>(
    method: "GET" | "POST",
    path: string,
    schema: RuntimeSchema<T>,
    options?: { body?: unknown; signal?: AbortSignal }
  ): Promise<T>;
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
  fetch?: typeof fetch;
  timeoutMs?: number;
}): WorkspaceJsonTransport {
  const request = input.fetch ?? fetch;
  return {
    async json(method, path, schema, options = {}) {
      let response: Response;
      try {
        response = await fetchWithDeadline({
          request,
          url: new URL(path, input.serverOrigin),
          callerSignal: options.signal,
          timeoutMs: input.timeoutMs ?? WORKSPACE_HTTP_TIMEOUT_MS,
          init: {
            method,
            headers: {
              authorization: `Bearer ${input.credential}`,
              accept: "application/json",
              ...(options.body === undefined ? {} : { "content-type": "application/json" })
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
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
    }
  };
}
