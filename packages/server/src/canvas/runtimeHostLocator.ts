import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import {
  canvasScopeRefSchema,
  projectScopeRefSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { HostRuntimeProjectObservation } from "@planweave-ai/agent-host-protocol";
import type { AgentHostRepository } from "../hosts.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { SqliteDatabase } from "../sqlite.js";
import type { RuntimeCanvasScope } from "./executionRuntimePort.js";

export type CanvasRuntimeHostBinding = Omit<RuntimeCanvasScope, "canvasId"> & {
  hostId: string;
  readinessStatus: HostRuntimeProjectObservation["status"];
  firstObservedAt: string;
  lastObservedAt: string;
};

export class CanvasRuntimeHostBindingRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly hosts: AgentHostRepository,
    private readonly clock: () => Date = () => new Date()
  ) {}

  synchronizeReadiness(
    hostId: string,
    observations: readonly HostRuntimeProjectObservation[] | undefined
  ): void {
    this.hosts.getRequired(hostId);
    const observedAt = this.clock().toISOString();
    this.database
      .prepare(
        `UPDATE canvas_runtime_host_bindings
         SET readiness_status='missing',last_observed_at=? WHERE host_id=?`
      )
      .run(observedAt, hostId);
    for (const observation of observations ?? []) {
      const workspaceId = workspaceIdSchema.parse(observation.workspaceId);
      if (observation.status !== "ready") {
        this.database
          .prepare(
            `UPDATE canvas_runtime_host_bindings
             SET readiness_status=?,last_observed_at=?
             WHERE host_id=? AND workspace_id=? AND project_id=?`
          )
          .run(observation.status, observedAt, hostId, workspaceId, observation.projectId);
        continue;
      }
      this.database
        .prepare(
          `INSERT INTO canvas_runtime_host_bindings(
             workspace_id,project_id,host_id,readiness_status,first_observed_at,last_observed_at
           ) VALUES (?,?,?,'ready',?,?)
           ON CONFLICT(workspace_id,project_id,host_id) DO UPDATE SET
             readiness_status='ready',last_observed_at=excluded.last_observed_at`
        )
        .run(workspaceId, observation.projectId, hostId, observedAt, observedAt);
    }
  }

  list(scopeInput: RuntimeCanvasScope): CanvasRuntimeHostBinding[] {
    const scope = canvasScopeRefSchema.parse(scopeInput);
    return this.listProject({ workspaceId: scope.workspaceId, projectId: scope.projectId });
  }

  listProject(scopeInput: { workspaceId: string; projectId: string }): CanvasRuntimeHostBinding[] {
    const scope = projectScopeRefSchema.parse(scopeInput);
    const rows = this.database
      .prepare(
        `SELECT workspace_id,project_id,host_id,readiness_status,first_observed_at,last_observed_at
         FROM canvas_runtime_host_bindings
         WHERE workspace_id=? AND project_id=?
         ORDER BY first_observed_at,host_id`
      )
      .all(scope.workspaceId, scope.projectId) as Array<{
      workspace_id: string;
      project_id: string;
      host_id: string;
      readiness_status: HostRuntimeProjectObservation["status"];
      first_observed_at: string;
      last_observed_at: string;
    }>;
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      hostId: row.host_id,
      readinessStatus: row.readiness_status,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at
    }));
  }
}

export type CanvasRuntimeHostSessionLookup = {
  isActive(hostId: string): boolean;
};

export type LocatedCanvasRuntimeHost =
  | { kind: "available"; hostId: string }
  | { kind: "unavailable"; reason: "runtime_not_attached" | "host_offline"; lastSeenAt?: string };

export class CanvasRuntimeHostAmbiguousError extends Error {
  constructor(readonly hostIds: readonly string[]) {
    super(`canvas_runtime_host_ambiguous:${hostIds.join(",")}`);
    this.name = "CanvasRuntimeHostAmbiguousError";
  }
}

/** Resolves one logical binding. Active WS session and negotiated capability are mandatory. */
export class CanvasRuntimeHostLocator {
  constructor(
    private readonly bindings: CanvasRuntimeHostBindingRepository,
    private readonly hosts: AgentHostRepository,
    private readonly sessions: CanvasRuntimeHostSessionLookup,
    private readonly projectAccess: ProjectAccessRepository
  ) {}

  locate(scopeInput: RuntimeCanvasScope): LocatedCanvasRuntimeHost {
    const scope = canvasScopeRefSchema.parse(scopeInput);
    const project = this.projectAccess.registry.projectInternal(scope.workspaceId, scope.projectId);
    const canvas = this.projectAccess.registry.canvasInternal(
      scope.workspaceId,
      scope.projectId,
      scope.canvasId
    );
    if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null) {
      throw new Error("canvas_runtime_scope_unavailable");
    }
    return this.locateBindings(this.bindings.list(scope));
  }

  hasAvailableProject(scopeInput: { workspaceId: string; projectId: string }): boolean {
    const scope = projectScopeRefSchema.parse(scopeInput);
    const project = this.projectAccess.registry.projectInternal(scope.workspaceId, scope.projectId);
    if (!project || project.revokedAt !== null) return false;
    try {
      return this.locateBindings(this.bindings.listProject(scope)).kind === "available";
    } catch (error) {
      if (error instanceof CanvasRuntimeHostAmbiguousError) return false;
      throw error;
    }
  }

  private locateBindings(bindings: readonly CanvasRuntimeHostBinding[]): LocatedCanvasRuntimeHost {
    if (bindings.length === 0) {
      return { kind: "unavailable", reason: "runtime_not_attached" };
    }
    const candidates = bindings.flatMap((binding) => {
      const host = this.hosts.get(binding.hostId);
      if (
        !host ||
        binding.readinessStatus !== "ready" ||
        host.revokedAt !== undefined ||
        !host.capabilities.includes(CANVAS_RUNTIME_CAPABILITY) ||
        !this.sessions.isActive(binding.hostId)
      ) {
        return [];
      }
      return [{ binding, host }];
    });
    if (candidates.length > 1) {
      throw new CanvasRuntimeHostAmbiguousError(candidates.map(({ host }) => host.id));
    }
    const candidate = candidates[0];
    if (candidate) return { kind: "available", hostId: candidate.host.id };
    const lastSeenAt = bindings
      .map(({ hostId }) => this.hosts.get(hostId)?.lastSeenAt)
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);
    return {
      kind: "unavailable",
      reason: "host_offline",
      ...(lastSeenAt ? { lastSeenAt } : {})
    };
  }
}
