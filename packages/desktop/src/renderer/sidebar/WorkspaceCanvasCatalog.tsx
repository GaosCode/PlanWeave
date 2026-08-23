import { ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { CanvasAccessRecord } from "@planweave-ai/collaboration-protocol/access/project";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc";
import type { createTranslator } from "../i18n";
import { AnimatedTreeRegion } from "./AnimatedTreeRegion";
import {
  CanvasTreeSelectButton,
  CanvasTreeToggleButton,
  TaskTreeSelectButton
} from "./CanvasTreePresentation";

type WorkspaceCanvasCatalogProps = {
  canvases: CanvasAccessRecord[];
  localProjects?: DesktopProjectSummary[];
  selectedCanvas: Pick<CanvasAccessRecord["registry"], "projectId" | "canvasId"> | null;
  onSelect?: (canvas: CanvasAccessRecord) => void;
  onTaskSelect?: (taskId: string) => void;
  selectedTaskId?: string | null;
  t: ReturnType<typeof createTranslator>;
  workspaceCanvasReplica?: CollaborationCanvasBindingReplicaProjection | null;
};

type LocalCanvasSummary = DesktopProjectSummary["taskCanvases"][number];

function remoteCanvasKey(canvas: Pick<CanvasAccessRecord["registry"], "projectId" | "canvasId">) {
  return `${canvas.projectId}\u0000${canvas.canvasId}`;
}

function matchingProjection(
  canvas: CanvasAccessRecord,
  projection: CollaborationCanvasBindingReplicaProjection | null | undefined
) {
  if (
    projection?.projectId === canvas.registry.projectId &&
    projection.canvasId === canvas.registry.canvasId
  ) {
    return projection;
  }
  return null;
}

function resolveLocalSource(
  canvas: CanvasAccessRecord,
  projectsById: ReadonlyMap<string, DesktopProjectSummary>
): { project: DesktopProjectSummary; canvas: LocalCanvasSummary } | null {
  const source = canvas.publishSource;
  if (!source) return null;
  const project = projectsById.get(source.localProjectId);
  const localCanvas = project?.taskCanvases.find(
    (candidate) => candidate.canvasId === source.localCanvasId
  );
  return project && localCanvas ? { project, canvas: localCanvas } : null;
}

function groupCanvases(
  canvases: CanvasAccessRecord[],
  projectsById: ReadonlyMap<string, DesktopProjectSummary>
) {
  const groups = new Map<string, CanvasAccessRecord[]>();
  for (const canvas of canvases) {
    const projectId = canvas.registry.projectId;
    const current = groups.get(projectId);
    if (current) current.push(canvas);
    else groups.set(projectId, [canvas]);
  }
  return [...groups.entries()].map(([projectId, projectCanvases]) => ({
    projectId,
    projectName:
      projectCanvases
        .map((canvas) => resolveLocalSource(canvas, projectsById)?.project.name)
        .find((name): name is string => Boolean(name)) ?? projectId,
    canvases: projectCanvases
  }));
}

export function WorkspaceCanvasCatalog({
  canvases,
  localProjects = [],
  selectedCanvas,
  onSelect,
  onTaskSelect,
  selectedTaskId = null,
  t,
  workspaceCanvasReplica = null
}: WorkspaceCanvasCatalogProps) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [collapsedCanvasKeys, setCollapsedCanvasKeys] = useState<Set<string>>(() => new Set());
  const projectsById = useMemo(
    () => new Map(localProjects.map((project) => [project.projectId, project])),
    [localProjects]
  );
  const groups = useMemo(() => groupCanvases(canvases, projectsById), [canvases, projectsById]);

  if (canvases.length === 0) return null;

  const toggleProject = (projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const toggleCanvas = (canvas: CanvasAccessRecord) => {
    const key = remoteCanvasKey(canvas.registry);
    const projection = matchingProjection(canvas, workspaceCanvasReplica);
    if (!projection) {
      setCollapsedCanvasKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      onSelect?.(canvas);
      return;
    }
    setCollapsedCanvasKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="mt-3 border-t border-border/70 pt-3" data-testid="workspace-canvas-catalog">
      <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
        {t("remoteCanvases")}
      </div>
      <div className="flex flex-col gap-1">
        {groups.map((group) => {
          const collapsed = collapsedProjectIds.has(group.projectId);
          return (
            <div className="flex min-w-0 flex-col" key={group.projectId}>
              <div className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-1">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="relative z-10 size-7 shrink-0 border-0 bg-transparent text-text-faint shadow-none hover:bg-surface-muted hover:text-text-strong focus-visible:ring-ring/40"
                  aria-expanded={!collapsed}
                  aria-label={`${t(collapsed ? "expandProject" : "collapseProject")}: ${group.projectName}`}
                  onClick={() => toggleProject(group.projectId)}
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-4 transition-transform duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)]",
                      collapsed ? "rotate-0" : "rotate-90"
                    )}
                  />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={group.projectName}
                  aria-expanded={!collapsed}
                  className="h-8 min-w-0 justify-between gap-2 overflow-hidden rounded-md px-2 text-left text-sm text-text-muted hover:bg-surface-muted hover:text-text-strong [&_svg]:size-4"
                  onClick={() => toggleProject(group.projectId)}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <GitBranchIcon className="shrink-0" data-icon="inline-start" />
                    <span className="truncate">{group.projectName}</span>
                  </span>
                  <Badge className="shrink-0" variant="outline">
                    {group.canvases.length}
                  </Badge>
                </Button>
              </div>
              <AnimatedTreeRegion
                expanded={!collapsed}
                unmountOnExit
                className="ml-3 flex flex-col gap-0.5 border-l border-border/60 pt-1 pl-4"
              >
                {group.canvases.map((canvas) => {
                  const localSource = resolveLocalSource(canvas, projectsById);
                  const projection = matchingProjection(canvas, workspaceCanvasReplica);
                  const selected =
                    selectedCanvas?.projectId === canvas.registry.projectId &&
                    selectedCanvas.canvasId === canvas.registry.canvasId;
                  const canvasKey = remoteCanvasKey(canvas.registry);
                  const expanded =
                    selected && Boolean(projection) && !collapsedCanvasKeys.has(canvasKey);
                  const canvasName =
                    projection?.content.projectTitle ||
                    localSource?.canvas.name ||
                    canvas.registry.canvasId;
                  const taskCount =
                    projection?.content.tasks.length ?? localSource?.canvas.taskCount ?? null;
                  return (
                    <div
                      className="flex w-full min-w-0 max-w-full flex-col overflow-hidden"
                      key={`${canvas.registry.workspaceId}:${canvas.registry.projectId}:${canvas.registry.canvasId}`}
                    >
                      <div className="grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-1">
                        <CanvasTreeSelectButton
                          label={canvasName}
                          selected={selected}
                          trailing={
                            taskCount === null ? null : (
                              <Badge className="shrink-0" variant="outline">
                                {taskCount}
                              </Badge>
                            )
                          }
                          onClick={() => onSelect?.(canvas)}
                        />
                        <CanvasTreeToggleButton
                          expanded={expanded}
                          t={t}
                          onToggle={(event) => {
                            event.stopPropagation();
                            toggleCanvas(canvas);
                          }}
                        />
                      </div>
                      <AnimatedTreeRegion
                        expanded={expanded}
                        unmountOnExit
                        className="ml-3 flex w-[calc(100%-0.75rem)] min-w-0 max-w-full flex-col gap-1 overflow-hidden border-l border-border/60 pt-1 pl-3"
                      >
                        {projection?.content.tasks.map((task) => (
                          <TaskTreeSelectButton
                            key={task.taskId}
                            selected={selectedTaskId === task.taskId}
                            task={task}
                            onSelect={() => onTaskSelect?.(task.taskId)}
                          />
                        ))}
                      </AnimatedTreeRegion>
                    </div>
                  );
                })}
              </AnimatedTreeRegion>
            </div>
          );
        })}
      </div>
    </section>
  );
}
