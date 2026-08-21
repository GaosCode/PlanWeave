import {
  canvasAccessRecordSchema,
  canvasAccessRequestSchema,
  canvasAccessPageSchema,
  projectAccessPageSchema,
  projectAccessRequestSchema,
  registryPageQuerySchema,
  type CanvasAccessPage,
  type CanvasAccessRecord,
  type ProjectAccessPage,
  type RegistryPageQuery
} from "@planweave-ai/collaboration-protocol/access/project";
import {
  createPackageSnapshotRequestSchema,
  createPackageSnapshotResultSchema,
  packageSnapshotSchema,
  restorePackageSnapshotRequestSchema,
  restorePackageSnapshotResultSchema,
  type CreatePackageSnapshotResult,
  type PackageSnapshot,
  type RestorePackageSnapshotResult
} from "@planweave-ai/collaboration-protocol/content/snapshot";
import type { z, ZodType } from "zod";

export type RegistryJsonRequest = <T>(
  method: "GET" | "POST",
  path: string,
  schema: ZodType<T>,
  options?: { body?: unknown; signal?: AbortSignal; acceptedStatus?: number }
) => Promise<T>;

export type RegistryPageInput = Partial<RegistryPageQuery>;

const restorePackageSnapshotReadRequestSchema = restorePackageSnapshotRequestSchema
  .pick({ projectId: true, canvasId: true, snapshotId: true })
  .strict();

function pageQuery(input: RegistryPageInput) {
  const query = registryPageQuerySchema.parse(input);
  return new URLSearchParams({ cursor: String(query.cursor), limit: String(query.limit) });
}

/** Typed registry-only command seam; transport and credentials remain in CollaborationClient. */
export class CollaborationRegistryClient {
  constructor(private readonly request: RegistryJsonRequest) {}

  async listProjects(
    input: RegistryPageInput = {},
    signal?: AbortSignal
  ): Promise<ProjectAccessPage> {
    return this.request(
      "GET",
      `/api/v1/registry/projects?${pageQuery(input)}`,
      projectAccessPageSchema,
      { signal }
    );
  }

  async listCanvases(
    input: z.input<typeof projectAccessRequestSchema> & RegistryPageInput,
    signal?: AbortSignal
  ): Promise<CanvasAccessPage> {
    const body = projectAccessRequestSchema.parse({ projectId: input.projectId });
    return this.request(
      "GET",
      `/api/v1/registry/projects/${encodeURIComponent(body.projectId)}/canvases?${pageQuery({ cursor: input.cursor, limit: input.limit })}`,
      canvasAccessPageSchema,
      { signal }
    );
  }

  async registerCanvas(
    input: z.input<typeof canvasAccessRequestSchema>,
    signal?: AbortSignal
  ): Promise<CanvasAccessRecord> {
    const body = canvasAccessRequestSchema.parse(input);
    return this.request(
      "POST",
      `/api/v1/registry/projects/${encodeURIComponent(body.projectId)}/canvases`,
      canvasAccessRecordSchema,
      { body, signal }
    );
  }

  async readSnapshot(
    input: z.input<typeof restorePackageSnapshotReadRequestSchema>,
    signal?: AbortSignal
  ): Promise<PackageSnapshot> {
    const parsed = restorePackageSnapshotReadRequestSchema.parse(input);
    return this.request(
      "GET",
      `/api/v1/registry/projects/${encodeURIComponent(parsed.projectId)}/canvases/${encodeURIComponent(parsed.canvasId)}/snapshots/${encodeURIComponent(parsed.snapshotId)}`,
      packageSnapshotSchema,
      { signal }
    );
  }

  async createSnapshot(
    input: z.input<typeof createPackageSnapshotRequestSchema>,
    signal?: AbortSignal
  ): Promise<CreatePackageSnapshotResult> {
    const body = createPackageSnapshotRequestSchema.parse(input);
    return this.request(
      "POST",
      `/api/v1/registry/projects/${encodeURIComponent(body.projectId)}/canvases/${encodeURIComponent(body.canvasId)}/snapshots`,
      createPackageSnapshotResultSchema,
      { body, signal }
    );
  }

  async restoreSnapshot(
    input: z.input<typeof restorePackageSnapshotRequestSchema>,
    signal?: AbortSignal
  ): Promise<RestorePackageSnapshotResult> {
    const body = restorePackageSnapshotRequestSchema.parse(input);
    return this.request(
      "POST",
      `/api/v1/registry/projects/${encodeURIComponent(body.projectId)}/canvases/${encodeURIComponent(body.canvasId)}/snapshots/${encodeURIComponent(body.snapshotId)}/restore`,
      restorePackageSnapshotResultSchema,
      { body, signal, acceptedStatus: 409 }
    );
  }
}

export type CollaborationRegistryReadSnapshotInput = z.input<
  typeof restorePackageSnapshotReadRequestSchema
>;
export type CollaborationRegistryClientOptions = { request: RegistryJsonRequest };
