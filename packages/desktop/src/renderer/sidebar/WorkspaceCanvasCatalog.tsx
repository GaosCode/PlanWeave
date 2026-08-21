import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { CanvasAccessRecord } from "@planweave-ai/collaboration-protocol/access/project";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

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
            <div key={group.projectId}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-text-muted hover:bg-surface-muted hover:text-text-strong"
                aria-expanded={!collapsed}
                onClick={() => toggleProject(group.projectId)}
              >
                {collapsed ? (
                  <ChevronRightIcon className="size-3.5 shrink-0" />
                ) : (
                  <ChevronDownIcon className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{group.projectId}</span>
                <span className="tabular-nums text-text-faint">{group.canvases.length}</span>
              </button>
              {!collapsed ? (
                <div className="ml-4 flex flex-col gap-0.5 border-l border-border/60 pl-2">
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
                      className="h-8 min-w-0 justify-start px-2 text-xs font-normal"
                      onClick={() => onSelect?.(canvas)}
                    >
                      <span className="truncate">{canvas.registry.canvasId}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
