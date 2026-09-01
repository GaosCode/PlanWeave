import {
  CANVAS_RUNTIME_CAPABILITY,
  opaqueIdentifierSchema,
  type HostRuntimeProjectObservation
} from "@planweave-ai/agent-host-protocol";
import {
  canvasScopeRefSchema,
  projectScopeRefSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
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

const bindingSelectColumns = `workspace_id,project_id,host_id,readiness_status,
         first_observed_at,last_observed_at`;

type BindingRow = {
  workspace_id: string;
  project_id: string;
  host_id: string;
  readiness_status: HostRuntimeProjectObservation["status"];
  first_observed_at: string;
  last_observed_at: string;
};

function toBinding(row: BindingRow): CanvasRuntimeHostBinding {
  return {
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    hostId: row.host_id,
    readinessStatus: row.readiness_status,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at
  };
}

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
         SET readiness_status='missing',last_observed_at=?
         WHERE host_id=?`
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
    const scope = canvasScopeRefSchema.parse({
      workspaceId: scopeInput.workspaceId,
      projectId: scopeInput.projectId,
      canvasId: scopeInput.canvasId
    });
    return this.listProject({ workspaceId: scope.workspaceId, projectId: scope.projectId });
  }

  listProject(scopeInput: { workspaceId: string; projectId: string }): CanvasRuntimeHostBinding[] {
    const scope = projectScopeRefSchema.parse(scopeInput);
    const rows = this.database
      .prepare(
        `SELECT ${bindingSelectColumns}
         FROM canvas_runtime_host_bindings
         WHERE workspace_id=? AND project_id=?
         ORDER BY first_observed_at,host_id`
      )
      .all(scope.workspaceId, scope.projectId) as BindingRow[];
    return rows.map(toBinding);
  }
}

export type CanvasRuntimeHostSessionLookup = {
  isActive(hostId: string): boolean;
};

export type LocatedCanvasRuntimeHost =
  | { kind: "available"; hostId: string }
  | { kind: "unavailable"; reason: "runtime_not_attached" | "host_offline"; lastSeenAt?: string };

export type LocatedCanvasRuntimeHostCandidates =
  | { kind: "available"; hostIds: readonly string[] }
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
    private readonly projectAccess: ProjectAccessRepository,
    private readonly ownerScopeAvailable?: (scope: RuntimeCanvasScope) => boolean
  ) {}

  locate(scopeInput: RuntimeCanvasScope): LocatedCanvasRuntimeHost {
    const candidates = this.locateCandidates(scopeInput);
    if (candidates.kind === "unavailable") return candidates;
    if (candidates.hostIds.length > 1) {
      throw new CanvasRuntimeHostAmbiguousError(candidates.hostIds);
    }
    return { kind: "available", hostId: candidates.hostIds[0]! };
  }

  /** Enumerates every viable Host for read-only evidence aggregation. */
  locateCandidates(scopeInput: RuntimeCanvasScope): LocatedCanvasRuntimeHostCandidates {
    const scope = this.assertScopeAvailable(scopeInput);
    return this.locateBindingCandidates(this.bindings.list(scope));
  }

  /**
   * Route a request to an already-authorized Host without requiring a persisted
   * ready binding. Used for first inspect/acquire before attachment exists.
   */
  locateAuthorizedHost(
    scopeInput: RuntimeCanvasScope,
    hostIdInput: string
  ): LocatedCanvasRuntimeHost {
    this.assertScopeAvailable(scopeInput);
    const hostId = opaqueIdentifierSchema.parse(hostIdInput);
    const host = this.hosts.get(hostId);
    if (
      !host ||
      host.revokedAt !== undefined ||
      !host.capabilities.includes(CANVAS_RUNTIME_CAPABILITY) ||
      !this.sessions.isActive(hostId)
    ) {
      return {
        kind: "unavailable",
        reason: host ? "host_offline" : "runtime_not_attached",
        ...(host?.lastSeenAt ? { lastSeenAt: host.lastSeenAt } : {})
      };
    }
    return { kind: "available", hostId: host.id };
  }

  private assertScopeAvailable(scopeInput: RuntimeCanvasScope) {
    const scope = canvasScopeRefSchema.parse({
      workspaceId: scopeInput.workspaceId,
      projectId: scopeInput.projectId,
      canvasId: scopeInput.canvasId
    });
    const project = this.projectAccess.registry.projectInternal(scope.workspaceId, scope.projectId);
    const canvas = this.projectAccess.registry.canvasInternal(
      scope.workspaceId,
      scope.projectId,
      scope.canvasId
    );
    const collaborationScopeAvailable =
      !!project && project.revokedAt === null && !!canvas && canvas.revokedAt === null;
    if (!collaborationScopeAvailable && this.ownerScopeAvailable?.(scope) !== true) {
      throw new Error("canvas_runtime_scope_unavailable");
    }
    return scope;
  }

  hasAvailableProject(scopeInput: { workspaceId: string; projectId: string }): boolean {
    const scope = projectScopeRefSchema.parse(scopeInput);
    const project = this.projectAccess.registry.projectInternal(scope.workspaceId, scope.projectId);
    if (!project || project.revokedAt !== null) return false;
    return this.locateBindingCandidates(this.bindings.listProject(scope)).kind === "available";
  }

  private locateBindingCandidates(
    bindings: readonly CanvasRuntimeHostBinding[]
  ): LocatedCanvasRuntimeHostCandidates {
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
    if (candidates.length > 0) {
      return { kind: "available", hostIds: candidates.map(({ host }) => host.id) };
    }
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
