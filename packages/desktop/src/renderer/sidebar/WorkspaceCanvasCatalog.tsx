import { ChevronRightIcon, GitBranchIcon, WorkflowIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { CanvasAccessRecord } from "@planweave-ai/collaboration-protocol/access/project";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { AnimatedTreeRegion } from "./AnimatedTreeRegion";

type WorkspaceCanvasCatalogProps = {
  canvases: CanvasAccessRecord[];
  selectedCanvas: Pick<CanvasAccessRecord["registry"], "projectId" | "canvasId"> | null;
  onSelect?: (canvas: CanvasAccessRecord) => void;
  t: ReturnType<typeof createTranslator>;
};

function groupCanvases(canvases: CanvasAccessRecord[]) {
  const groups = new Map<string, CanvasAccessRecord[]>();
  for (const canvas of canvases) {
    const projectId = canvas.registry.projectId;
    const current = groups.get(projectId);
    if (current) current.push(canvas);
    else groups.set(projectId, [canvas]);
  }
  return [...groups.entries()].map(([projectId, projectCanvases]) => ({
    projectId,
    canvases: projectCanvases
  }));
}

export function WorkspaceCanvasCatalog({
  canvases,
  selectedCanvas,
  onSelect,
  t
}: WorkspaceCanvasCatalogProps) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => groupCanvases(canvases), [canvases]);

  if (canvases.length === 0) return null;

  const toggleProject = (projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
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
                  aria-label={`${t(collapsed ? "expandProject" : "collapseProject")}: ${group.projectId}`}
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
                  aria-label={group.projectId}
                  aria-expanded={!collapsed}
                  className="h-8 min-w-0 justify-between gap-2 overflow-hidden rounded-md px-2 text-left text-sm text-text-muted hover:bg-surface-muted hover:text-text-strong [&_svg]:size-4"
                  onClick={() => toggleProject(group.projectId)}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <GitBranchIcon className="shrink-0" data-icon="inline-start" />
                    <span className="truncate">{group.projectId}</span>
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
                {group.canvases.map((canvas) => (
                  <Button
                    key={`${canvas.registry.workspaceId}:${canvas.registry.projectId}:${canvas.registry.canvasId}`}
                    size="sm"
                    variant={
                      selectedCanvas?.projectId === canvas.registry.projectId &&
                      selectedCanvas.canvasId === canvas.registry.canvasId
                        ? "secondary"
                        : "ghost"
                    }
                    aria-current={
                      selectedCanvas?.projectId === canvas.registry.projectId &&
                      selectedCanvas.canvasId === canvas.registry.canvasId
                        ? "page"
                        : undefined
                    }
                    className="h-8 min-w-0 justify-between gap-2 overflow-hidden rounded-md px-2 text-xs font-normal text-text-muted hover:bg-surface-muted hover:text-text-strong data-[variant=secondary]:border-state-selected/25 data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-text-strong data-[variant=secondary]:shadow-sm [&_svg]:size-4"
                    onClick={() => onSelect?.(canvas)}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <WorkflowIcon className="shrink-0" data-icon="inline-start" />
                      <span className="truncate">{canvas.registry.canvasId}</span>
                    </span>
                  </Button>
                ))}
              </AnimatedTreeRegion>
            </div>
          );
        })}
      </div>
    </section>
  );
}
