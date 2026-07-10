import { useMemo, useState } from "react";
import type {
  DesktopCanvasReference,
  DesktopGraphViewModel,
  DesktopLockGroup
} from "@planweave-ai/runtime";
import { LockIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { lockColor } from "../graph/lockColors";
import { bridge } from "../bridge";

export type ResourceInspectorProps = {
  canvasRef: DesktopCanvasReference | null;
  className?: string;
  graph: DesktopGraphViewModel;
  lockGroup: DesktopLockGroup;
  onClose: () => void;
  onJumpToTask: (taskId: string) => void;
  onRefresh: () => Promise<void>;
  t: ReturnType<typeof createTranslator>;
};

type MemberRow = {
  taskId: string;
  title: string;
  blockRef: string;
  kind: "holder" | "waiting" | "dispatchable" | "blocked" | "other";
  status: string;
  dispatchable: boolean;
  waitingOnHolder: string | null;
  exceptionReason: string | null;
};

function taskIdFromRef(ref: string): string {
  return ref.includes("#") ? ref.slice(0, ref.indexOf("#")) : ref;
}

function buildMemberRows(graph: DesktopGraphViewModel, lockGroup: DesktopLockGroup): MemberRow[] {
  const rows: MemberRow[] = [];
  for (const taskId of lockGroup.memberTaskIds) {
    const task = graph.tasks.find((item) => item.taskId === taskId);
    if (!task) {
      continue;
    }
    const blocks = task.blocks.filter(
      (block) =>
        block.type === "implementation" &&
        (task.locks.includes(lockGroup.name) ||
          block.waitingOn?.lock === lockGroup.name ||
          (lockGroup.holderRef != null && taskIdFromRef(lockGroup.holderRef) === taskId))
    );
    const block =
      blocks.find((item) => item.ref === lockGroup.holderRef) ??
      blocks.find((item) => item.waitingOn?.lock === lockGroup.name) ??
      blocks[0] ??
      task.blocks.find((item) => item.type === "implementation") ??
      null;
    if (!block) {
      continue;
    }
    let kind: MemberRow["kind"] = "other";
    if (lockGroup.holderRef === block.ref) {
      kind = "holder";
    } else if (block.waitingOn?.lock === lockGroup.name) {
      kind = "waiting";
    } else if (block.dispatchable) {
      kind = "dispatchable";
    } else if (block.status === "blocked") {
      kind = "blocked";
    }
    rows.push({
      taskId,
      title: task.title,
      blockRef: block.ref,
      kind,
      status: block.status,
      dispatchable: block.dispatchable,
      waitingOnHolder: block.waitingOn?.holderRef ?? null,
      exceptionReason: block.exceptionReason
    });
  }
  const order = { holder: 0, waiting: 1, dispatchable: 2, blocked: 3, other: 4 } as const;
  return rows.sort((left, right) => order[left.kind] - order[right.kind]);
}

export function ResourceInspector({
  canvasRef,
  className,
  graph,
  lockGroup,
  onClose,
  onJumpToTask,
  onRefresh,
  t
}: ResourceInspectorProps) {
  const [reason, setReason] = useState("");
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const color = lockColor(lockGroup.name);
  const rows = useMemo(() => buildMemberRows(graph, lockGroup), [graph, lockGroup]);

  const runAction = async (blockRef: string, action: () => Promise<void>) => {
    if (!canvasRef || !bridge) {
      setError("Bridge unavailable");
      return;
    }
    setBusyRef(blockRef);
    setError(null);
    try {
      await action();
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyRef(null);
    }
  };

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
          <span className="truncate">
            {lockGroup.name === "exclusive" ? t("exclusiveLock") : lockGroup.name}
          </span>
          <Badge variant="outline" className="ml-auto shrink-0">
            {lockGroup.holderRef ? t("lockHeld") : t("lockFree")}
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
        <div className="text-xs font-medium text-text-muted">{t("resourceMembers")}</div>
        {rows.map((row) => (
          <div
            key={row.blockRef}
            className="rounded-md border border-border/70 bg-surface-muted p-2"
            data-testid="resource-inspector-member"
            data-member-kind={row.kind}
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
              {row.waitingOnHolder ? ` · ${t("heldBy")} ${row.waitingOnHolder}` : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {row.kind === "holder" ? (
                <div className="flex w-full flex-col gap-1.5">
                  <Input
                    aria-label={t("blockedReasonRequired")}
                    data-testid="resource-inspector-reason"
                    placeholder={t("blockedReasonRequired")}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busyRef === row.blockRef}
                    data-testid="resource-inspector-mark-blocked"
                    onClick={() => {
                      if (!reason.trim()) {
                        setError(t("blockedReasonRequired"));
                        return;
                      }
                      void runAction(row.blockRef, async () => {
                        await bridge!.markBlockedBlock(canvasRef!, row.blockRef, reason.trim());
                        setReason("");
                      });
                    }}
                  >
                    <LockIcon data-icon="inline-start" />
                    {t("markBlockedRelease")}
                  </Button>
                </div>
              ) : null}
              {row.kind === "waiting" || row.kind === "dispatchable" ? (
                <Button
                  size="sm"
                  disabled={!row.dispatchable || busyRef === row.blockRef}
                  data-testid="resource-inspector-dispatch"
                  onClick={() =>
                    void runAction(row.blockRef, async () => {
                      const result = await bridge!.dispatchBlock(canvasRef!, row.blockRef);
                      if (result.kind === "blocked" || result.kind === "none") {
                        throw new Error(
                          result.reason ?? `Dispatch refused for ${row.blockRef}`
                        );
                      }
                    })
                  }
                >
                  {t("dispatchNow")}
                </Button>
              ) : null}
              {row.kind === "blocked" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyRef === row.blockRef}
                  data-testid="resource-inspector-unblock"
                  onClick={() =>
                    void runAction(row.blockRef, async () => {
                      await bridge!.unblockBlock(
                        canvasRef!,
                        row.blockRef,
                        "Unblocked from resource inspector"
                      );
                    })
                  }
                >
                  {t("unblock")}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        {error ? (
          <div className="text-xs text-state-failed" data-testid="resource-inspector-error">
            {error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
