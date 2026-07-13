import type { DesktopProjectExecutionPlan, DesktopTodoGroups } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { TodoGroupCard } from "../components/TodoGroupCard";
import type { createTranslator } from "../i18n";

type TodoViewProps = {
  executionPlan: DesktopProjectExecutionPlan | null;
  handleBlockSelect: (ref: string, canvasId?: string | null) => Promise<void>;
  t: ReturnType<typeof createTranslator>;
  todoGroups: DesktopTodoGroups | null;
};

const visibleTodoStatuses = ["ready", "in_progress", "needs_changes", "blocked", "diverged", "implemented"] as const;

type StatusKey = (typeof visibleTodoStatuses)[number];
type Tone = "emerald" | "sky" | "amber" | "rose" | "violet" | "neutral";

const statusTone: Record<StatusKey, Tone> = {
  ready: "emerald",
  in_progress: "sky",
  needs_changes: "amber",
  blocked: "rose",
  diverged: "violet",
  implemented: "neutral"
};

const toneBar: Record<Tone, string> = {
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  violet: "bg-violet-500",
  neutral: "bg-foreground/35"
};

const toneDot: Record<Tone, string> = {
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  violet: "bg-violet-500",
  neutral: "bg-foreground/40"
};

export function TodoView({ executionPlan, handleBlockSelect, t, todoGroups }: TodoViewProps) {
  const readyCount = executionPlan?.readyQueue.length ?? todoGroups?.ready.length ?? 0;

  const statusLabel = (status: StatusKey) =>
    t(status === "in_progress" ? "inProgress" : status === "needs_changes" ? "needsChanges" : status);

  const distribution = visibleTodoStatuses.map((status) => ({ status, count: todoGroups?.[status].length ?? 0 }));
  const distributionTotal = distribution.reduce((total, item) => total + item.count, 0);
  const note = executionPlan?.notes[0] ?? `${t("readyQueue")}: ${readyCount}`;

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col gap-3 pr-3 pb-2">
        <section className="animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-md border border-border/80 bg-surface-raised text-text shadow-sm duration-500">
          <div className="grid lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)]">
            <div className="flex flex-col justify-between gap-7 border-b border-border/80 bg-surface-muted/70 p-6 lg:border-r lg:border-b-0">
              <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {t("todo")}
              </div>
              <div className="flex items-end gap-3">
                <span className="font-mono text-6xl leading-none font-semibold tracking-tight tabular-nums">{readyCount}</span>
                <span className="pb-1.5 text-sm text-muted-foreground">{t("readyQueue")}</span>
              </div>
            </div>
            <div className="flex flex-col justify-center gap-4 p-6">
              <SegmentedBar items={distribution} total={distributionTotal} />
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {distribution.map(({ count, status }) => (
                  <div className="flex items-center gap-1.5" key={status}>
                    <span className={cn("size-1.5 rounded-full", toneDot[statusTone[status]])} />
                    <span className="text-xs text-muted-foreground">{statusLabel(status)}</span>
                    <span className="font-mono text-xs font-medium tabular-nums">{count}</span>
                  </div>
                ))}
              </div>
              <p className="max-w-3xl text-sm text-muted-foreground">{note}</p>
            </div>
          </div>
        </section>

        {executionPlan ? (
          <section className="animate-in fade-in slide-in-from-bottom-2 rounded-md border border-border/80 bg-surface-raised p-4 shadow-sm delay-75 duration-500">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-base font-semibold">{t("canvasPhases")}</h2>
                <p className="text-xs text-muted-foreground">{executionPlan.notes[0]}</p>
              </div>
              <Badge className="h-6 font-mono tabular-nums" variant="secondary">
                {t("readyQueue")}: {executionPlan.readyQueue.length}
              </Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {executionPlan.phases.map((phase) => {
                const parallel = phase.parallelReadyQueue.length;
                const sequential = phase.sequentialReadyQueue.length;
                const blocked = phase.blockedCount;
                return (
                  <div className="rounded-md border border-border/80 bg-surface-base p-4 shadow-sm transition-shadow hover:shadow-md" key={phase.canvasId}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                          {t("phase")} {phase.phaseIndex}
                        </div>
                        <div className="mt-0.5 truncate text-sm font-semibold">{phase.canvasName}</div>
                      </div>
                      <Badge className="shrink-0 font-mono tabular-nums" variant="outline">
                        {t("ready")}: {phase.readyQueue.length}
                      </Badge>
                    </div>
                    <div className="mt-3">
                      <SegmentedBar
                        items={[
                          { status: "parallel", count: parallel, tone: "emerald" },
                          { status: "sequential", count: sequential, tone: "amber" },
                          { status: "blocked", count: blocked, tone: "rose" }
                        ]}
                        total={parallel + sequential + blocked}
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <LegendItem count={parallel} label={t("parallelSafe")} tone="emerald" />
                        <LegendItem count={sequential} label={t("parallelBlocked")} tone="amber" />
                        <LegendItem count={blocked} label={t("blocked")} tone="rose" />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {phase.readyQueue.length > 0 ? (
                        phase.readyQueue.map((item) => (
                          <Button
                            className="h-7 font-mono"
                            key={`${item.canvasId}:${item.ref}`}
                            onClick={() => void handleBlockSelect(item.ref, item.canvasId)}
                            size="sm"
                            variant="outline"
                          >
                            {item.ref}
                          </Button>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("noReadyBlocks")}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {todoGroups
            ? visibleTodoStatuses.map((status) => (
                <TodoGroupCard
                  items={todoGroups[status]}
                  key={status}
                  labels={{
                    dependencyBlockers: t("dependencyBlockers"),
                    locks: t("locks"),
                    noBlockers: t("noBlockers"),
                    noLocks: t("noLocks"),
                    parallelBlocked: t("parallelBlocked"),
                    parallelSafe: t("parallelSafe"),
                    parallelSafety: t("parallelSafety"),
                    reviewExecutor: t("reviewExecutor"),
                    reviewGate: t("reviewGate"),
                    reviewNeedsChangesReturnsTo: t("reviewNeedsChangesReturnsTo"),
                    reviewRequired: t("reviewRequired"),
                    reviewUnlocks: t("reviewUnlocks"),
                    statusLabel: statusLabel(status)
                  }}
                  onSelect={(item) => void handleBlockSelect(item.ref, item.canvasId)}
                  status={status}
                />
              ))
            : null}
        </div>
      </div>
    </ScrollArea>
  );
}

function SegmentedBar({
  items,
  total
}: {
  items: { status: StatusKey | string; count: number; tone?: Tone }[];
  total: number;
}) {
  return (
    <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
      {total === 0
        ? null
        : items.map((item) =>
            item.count > 0 ? (
              <div
                className={cn("h-full transition-[width] duration-700 ease-out", toneBar[item.tone ?? statusTone[item.status as StatusKey]])}
                key={item.status}
                style={{ width: `${(item.count / total) * 100}%` }}
              />
            ) : null
          )}
    </div>
  );
}

function LegendItem({ count, label, tone }: { count: number; label: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", toneDot[tone])} />
      <span>{label}</span>
      <span className="font-mono font-medium text-foreground/80 tabular-nums">{count}</span>
    </div>
  );
}
