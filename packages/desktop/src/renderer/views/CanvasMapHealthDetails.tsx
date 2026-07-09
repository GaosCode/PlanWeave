import type {
  DesktopCanvasGraphViewModel,
  DesktopCanvasHealthBlockedBlock,
  DesktopCanvasHealthBlocker
} from "@planweave-ai/runtime";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";

export function CanvasMapHealthDiagnostics({
  diagnostics,
  severity,
  t
}: {
  diagnostics: DesktopCanvasGraphViewModel["health"]["diagnostics"];
  severity: DesktopCanvasGraphViewModel["health"]["severity"];
  t: ReturnType<typeof createTranslator>;
}) {
  if (diagnostics.length === 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1 overflow-hidden">
      <div className="text-xs text-muted-foreground">{t("projectGraphDiagnostics")}</div>
      {diagnostics.map((diagnostic) => (
        <div
          className={cn(
            "min-w-0 max-w-full overflow-hidden rounded-md border p-2 text-xs",
            severity === "error"
              ? "border-destructive/30 bg-destructive/10"
              : "border-state-warning/60 bg-state-warning-surface"
          )}
          key={`${diagnostic.code}-${diagnostic.path ?? ""}-${diagnostic.message}`}
        >
          <div className="font-medium" style={{ overflowWrap: "anywhere" }}>
            {diagnostic.code}
          </div>
          <div style={{ overflowWrap: "anywhere" }}>{diagnostic.message}</div>
        </div>
      ))}
    </div>
  );
}

function blockerLabel(blocker: DesktopCanvasHealthBlocker): string {
  if (blocker.kind === "canvas") {
    return `${blocker.canvasTitle} (${blocker.canvasId})`;
  }
  return `${blocker.canvasTitle}:${blocker.taskTitle} (${blocker.canvasId}:${blocker.taskId})`;
}

export function CanvasMapBlockedBlocksList({
  blockers,
  onBlockOpen,
  onCanvasOpen,
  onTaskOpen,
  t
}: {
  blockers: DesktopCanvasHealthBlockedBlock[];
  onBlockOpen: (canvasId: string, blockRef: string) => void;
  onCanvasOpen: (canvasId: string) => void;
  onTaskOpen: (canvasId: string, taskId: string) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  if (blockers.length === 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <AlertTriangleIcon className="size-3" aria-hidden="true" />
        {t("dependencyBlockers")}
      </div>
      {blockers.map((item) => (
        <div
          className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden rounded-md border bg-muted/40 p-2 text-xs"
          key={`${item.blocked.canvasId}:${item.blocked.blockRef}:${item.reason}`}
        >
          <div className="min-w-0">
            <div className="text-muted-foreground">{t("blockedBlock")}</div>
            <div className="font-mono" style={{ overflowWrap: "anywhere" }}>
              {item.blocked.canvasId}:{item.blocked.blockRef}
            </div>
            <div className="truncate font-medium">{item.blocked.blockTitle}</div>
          </div>
          <div className="min-w-0">
            <div className="text-muted-foreground">{t("blockedBy")}</div>
            <div className="flex flex-col gap-1">
              {item.blockers.map((blocker) => (
                <div
                  className="flex min-w-0 items-center justify-between gap-2"
                  key={`${item.blocked.canvasId}:${item.blocked.blockRef}:${blocker.kind}:${blocker.canvasId}${blocker.kind === "task" ? `:${blocker.taskId}` : ""}`}
                >
                  <span className="min-w-0 truncate">{blockerLabel(blocker)}</span>
                  <Button
                    className="min-w-0 shrink-0"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      blocker.kind === "task"
                        ? onTaskOpen(blocker.canvasId, blocker.taskId)
                        : onCanvasOpen(blocker.canvasId)
                    }
                  >
                    {blocker.kind === "task" ? t("openTask") : t("enterCanvas")}
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
            {item.reason}
          </div>
          <div className="flex min-w-0 gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onTaskOpen(item.blocked.canvasId, item.blocked.taskId)}
            >
              {t("openTask")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onBlockOpen(item.blocked.canvasId, item.blocked.blockRef)}
            >
              {t("openBlock")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
