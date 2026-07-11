import { useMemo } from "react";
import type {
  DesktopCanvasReference,
  DesktopGraphViewModel,
  DesktopSharedResourceGroup
} from "@planweave-ai/runtime";
import { InfoIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { lockColor } from "../graph/lockColors";

export type ResourceInspectorProps = {
  canvasRef: DesktopCanvasReference | null;
  className?: string;
  graph: DesktopGraphViewModel;
  lockGroup: DesktopSharedResourceGroup;
  onClose: () => void;
  onJumpToTask: (taskId: string) => void;
  onRefresh: () => Promise<void>;
  t: ReturnType<typeof createTranslator>;
};

type MemberRow = {
  taskId: string;
  title: string;
  blockRef: string;
  status: string;
  active: boolean;
};

function buildMemberRows(
  graph: DesktopGraphViewModel,
  group: DesktopSharedResourceGroup
): MemberRow[] {
  const activeRefs = new Set(group.activeBlockRefs);
  return group.memberBlockRefs
    .flatMap((blockRef) => {
      const task = graph.tasks.find((candidate) =>
        candidate.blocks.some((block) => block.ref === blockRef)
      );
      const block = task?.blocks.find((candidate) => candidate.ref === blockRef);
      return task && block
        ? [
            {
              taskId: task.taskId,
              title: task.title,
              blockRef,
              status: block.status,
              active: activeRefs.has(blockRef)
            }
          ]
        : [];
    })
    .sort((left, right) => Number(right.active) - Number(left.active));
}

export function ResourceInspector({
  className,
  graph,
  lockGroup,
  onClose,
  onJumpToTask,
  t
}: ResourceInspectorProps) {
  const color = lockColor(lockGroup.name);
  const rows = useMemo(() => buildMemberRows(graph, lockGroup), [graph, lockGroup]);
  const overlap = lockGroup.activeBlockRefs.length > 1;

  return (
    <Card
      className={cn("pointer-events-auto w-[340px] border shadow-lg", className)}
      data-testid="resource-inspector"
      size="sm"
    >
      <CardHeader className="min-h-10">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-full"
            style={{ backgroundColor: color.dot }}
          />
          <span className="truncate">{lockGroup.name}</span>
          <Badge variant="outline" className="ml-auto shrink-0">
            {t("sharedResourceHint")}
          </Badge>
        </CardTitle>
        <CardAction>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("unpinResource")}
            data-testid="resource-inspector-close"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex gap-2 rounded-md bg-surface-muted p-2 text-xs text-text-muted">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{t(overlap ? "sharedResourceOverlap" : "sharedResourceNonBlocking")}</span>
        </div>
        <div className="text-xs font-medium text-text-muted">{t("resourceMembers")}</div>
        {rows.map((row) => (
          <div
            key={row.blockRef}
            className="rounded-md border border-border/70 bg-surface-muted p-2"
            data-testid="resource-inspector-member"
            data-member-kind={row.active ? "active" : "other"}
          >
            <button
              type="button"
              className="text-left text-sm font-medium text-text-strong hover:underline"
              onClick={() => onJumpToTask(row.taskId)}
            >
              {row.taskId} · {row.title}
            </button>
            <div className="mt-0.5 text-xs text-text-muted">
              {row.blockRef} · {row.status}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
