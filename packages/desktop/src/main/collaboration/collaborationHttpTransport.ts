import { assertHumanDisplayDtoRedacted } from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  collaborationClientLimitsSchema,
  collaborationServerOriginSchema,
  type CollaborationClientLimits
} from "@planweave-ai/collaboration-protocol/connection";
import type { ZodType } from "zod";
import {
  CollaborationClientError,
  collaborationErrorFromHttp,
  collaborationErrorFromUnknown
} from "./collaborationErrors.js";
import type {
  CollaborationClientClock,
  CollaborationCredentialPort
} from "./collaborationClientTypes.js";
import { systemCollaborationClock } from "./collaborationClientTypes.js";

export type JsonMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type CollaborationHttpTransportOptions = {
  serverBaseUrl: string;
  credential: CollaborationCredentialPort;
  limits?: Partial<CollaborationClientLimits>;
  request?: typeof fetch;
  clock?: CollaborationClientClock;
};

export type CollaborationHttpStream = {
  response: Response;
  timedOut(): boolean;
  release(): void;
};

/**
 * Credential injection + bounded JSON HTTP transport for collaboration clients.
 * Callers never see raw Authorization headers or tokens.
 */
export class CollaborationHttpTransport {
  readonly serverBaseUrl: string;
  readonly limits: CollaborationClientLimits;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: CollaborationClientClock;
  private readonly credential: CollaborationCredentialPort;
  private readonly rootController = new AbortController();
  private disposed = false;

  constructor(options: CollaborationHttpTransportOptions) {
    this.serverBaseUrl = collaborationServerOriginSchema.parse(options.serverBaseUrl);
    this.limits = collaborationClientLimitsSchema.parse(options.limits ?? {});
    this.fetchImpl = options.request ?? fetch;
    this.clock = options.clock ?? systemCollaborationClock;
    this.credential = options.credential;
  }

  get disposedOrAborted(): boolean {
    return this.disposed || this.rootController.signal.aborted;
  }

  ensureOpen(): void {
    if (this.disposedOrAborted) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_disposed",
        message: "CollaborationClient has been disposed."
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rootController.abort();
  }

  async applyAuth(headers: Record<string, string>): Promise<void> {
    const token = await this.credential.getDeviceToken();
    if (!token) {
      throw new CollaborationClientError({
        kind: "auth",
        code: "collaboration_credential_missing",
        message: "Human device credential is not available."
      });
    }
    headers.authorization = `Bearer ${token}`;
  }

  async jsonEmpty(
    method: JsonMethod,
    path: string,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    await this.json(method, path, undefined, options);
  }

  async json<T>(
    method: JsonMethod,
    path: string,
    schema: ZodType<T> | undefined,
    options: {
      body?: unknown;
      auth?: boolean;
      signal?: AbortSignal;
      /** HTTP statuses that still carry a contract body (e.g. canvas CAS 409). */
      acceptedStatus?: number | number[];
    } = {}
  ): Promise<T> {
    this.ensureOpen();
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    if (options.auth !== false) {
      await this.applyAuth(headers);
    }
    const { response, text } = await this.readJsonResponse(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    const accepted = normalizeAccepted(options.acceptedStatus);
    if (!response.ok && !accepted.has(response.status)) {
      throw collaborationErrorFromHttp(response.status, text, response.headers.get("retry-after"));
    }
    if (schema === undefined) {
      if (text.length === 0) return undefined as T;
      try {
        JSON.parse(text);
      } catch {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "collaboration_malformed_json",
          message: "Response was not valid JSON."
        });
      }
      return undefined as T;
    }
    let value: unknown;
    try {
      value = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_malformed_json",
        message: "Response was not valid JSON."
      });
    }
    try {
      const parsed = schema.parse(value);
      assertHumanDisplayDtoRedacted(parsed);
      return parsed;
    } catch (error) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_response_invalid",
        message: "Response failed contract validation.",
        cause: error
      });
    }
  }

  async jsonNullable<T>(
    method: JsonMethod,
    path: string,
    schema: ZodType<T>,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal } = {}
  ): Promise<T | null> {
    this.ensureOpen();
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    if (options.auth !== false) {
      await this.applyAuth(headers);
    }
    const { response, text } = await this.readJsonResponse(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    if (!response.ok) {
      throw collaborationErrorFromHttp(response.status, text, response.headers.get("retry-after"));
    }
    let value: unknown;
    try {
      value = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_malformed_json",
        message: "Response was not valid JSON."
      });
    }
    if (value === null) return null;
    try {
      const parsed = schema.parse(value);
      assertHumanDisplayDtoRedacted(parsed);
      return parsed;
    } catch (error) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_response_invalid",
        message: "Response failed contract validation.",
        cause: error
      });
    }
  }

  /** Opens a non-JSON response stream while retaining credential ownership at this boundary. */
  async openStream(
    method: JsonMethod,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; accept: string }
  ): Promise<CollaborationHttpStream> {
    this.ensureOpen();
    const headers: Record<string, string> = { accept: options.accept };
    if (options.body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    await this.applyAuth(headers);
    return this.startRequest(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
  }

  async readBoundedError(response: Response): Promise<string> {
    return this.readTextLimited(response);
  }

  async readBytesLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      await response.body?.cancel();
      throw new CollaborationClientError({
        kind: "payload_too_large",
        code: "collaboration_response_too_large",
        message: "Response exceeded body size limit.",
        httpStatus: response.status
      });
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytesRead += next.value.byteLength;
        if (bytesRead > maxBytes) {
          throw new CollaborationClientError({
            kind: "payload_too_large",
            code: "collaboration_response_too_large",
            message: "Response exceeded body size limit.",
            httpStatus: response.status
          });
        }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      await reader.cancel(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async send(
    path: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
    const stream = await this.startRequest(path, init);
    stream.release();
    return stream.response;
  }

  private async readJsonResponse(
    path: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
      signal?: AbortSignal;
    }
  ): Promise<{ response: Response; text: string }> {
    const stream = await this.startRequest(path, init);
    try {
      return {
        response: stream.response,
        text: await this.readTextLimited(stream.response)
      };
    } catch (error) {
      if (stream.timedOut()) {
        throw new CollaborationClientError({
          kind: "timeout",
          code: "collaboration_timeout",
          message: "Collaboration request timed out.",
          retryable: true,
          cause: error
        });
      }
      throw error;
    } finally {
      stream.release();
    }
  }

  private async startRequest(
    path: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
      signal?: AbortSignal;
    }
  ): Promise<CollaborationHttpStream> {
    const url = new URL(path, this.serverBaseUrl);
    const timeout = new AbortController();
    const timer = this.clock.setTimeout(() => timeout.abort(), this.limits.requestTimeoutMs);
    const signals = [this.rootController.signal, timeout.signal];
    if (init.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    try {
      const body: BodyInit | undefined =
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : Buffer.from(init.body);
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body,
        signal
      });
      let released = false;
      return {
        response,
        timedOut: () => timeout.signal.aborted && !this.rootController.signal.aborted,
        release: () => {
          if (released) return;
          released = true;
          this.clock.clearTimeout(timer);
        }
      };
    } catch (error) {
      this.clock.clearTimeout(timer);
      if (signal.aborted && timeout.signal.aborted && !this.rootController.signal.aborted) {
        throw new CollaborationClientError({
          kind: "timeout",
          code: "collaboration_timeout",
          message: "Collaboration request timed out.",
          retryable: true,
          cause: error
        });
      }
      throw collaborationErrorFromUnknown(error);
    }
  }

  private async readTextLimited(response: Response): Promise<string> {
    const bytes = await this.readBytesLimited(response, this.limits.jsonBodyMaxBytes);
    return Buffer.from(bytes).toString("utf8");
  }
}

function normalizeAccepted(value: number | number[] | undefined): Set<number> {
  if (value === undefined) return new Set();
  return new Set(Array.isArray(value) ? value : [value]);
}
