import type { DesktopStatistics } from "@planweave-ai/runtime";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { formatElapsed, formatPercent } from "../viewHelpers";

type StatisticsViewProps = {
  statistics: DesktopStatistics | null;
  t: ReturnType<typeof createTranslator>;
};

type Tone = "neutral" | "emerald" | "sky" | "amber" | "rose";

const toneBar: Record<Tone, string> = {
  neutral: "bg-foreground",
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500"
};

const toneDot: Record<Tone, string> = {
  neutral: "bg-foreground/60",
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500"
};

export function StatisticsView({ statistics, t }: StatisticsViewProps) {
  if (!statistics) {
    return null;
  }

  const implementedPercent = clampPercent(statistics.implementedRatio * 100);
  const reviewPercent = clampPercent(statistics.reviewPassedRatio * 100);

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col gap-3 pr-3 pb-2">
        <section className="animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm duration-500">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
            <div className="flex flex-col justify-between gap-7 p-6">
              <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
                <span className="size-1.5 rounded-full bg-foreground" />
                {t("statistics")}
              </div>
              <div>
                <div className="flex items-end gap-3">
                  <span className="font-mono text-6xl leading-none font-semibold tracking-tight tabular-nums">
                    {formatPercent(statistics.implementedRatio)}
                  </span>
                  <span className="pb-1.5 text-sm text-muted-foreground">{t("implementedRatio")}</span>
                </div>
                <div className="mt-5">
                  <Meter tone="neutral" value={implementedPercent} />
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{t("blocks")}</span>
                    <span className="font-mono tabular-nums">
                      {statistics.completedBlockCount}/{statistics.blockTotal}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 divide-x border-t bg-muted/30 lg:border-t-0 lg:border-l">
              <HeroStat
                label={t("tasks")}
                value={`${statistics.implementedTaskCount}/${statistics.taskTotal}`}
              />
              <HeroStat label={t("taskThroughput")} value={String(statistics.taskThroughput)} />
              <HeroStat label={t("remaining")} value={String(statistics.estimatedRemainingBlocks)} />
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            delay={60}
            hint={formatPercent(statistics.reviewPassedRatio)}
            label={t("reviewsPassed")}
            meter={reviewPercent}
            tone="sky"
            value={String(statistics.reviewPassedCount)}
          />
          <MetricTile
            delay={120}
            label={t("averageImplementationTime")}
            tone="neutral"
            value={statistics.averageImplementationTimeMs === null ? "—" : formatElapsed(statistics.averageImplementationTimeMs)}
          />
          <MetricTile delay={180} label={t("feedback")} tone="amber" value={String(statistics.feedbackEnvelopeCount)} />
          <MetricTile delay={240} label={t("reworkCount")} tone="rose" value={String(statistics.reworkCount)} />
        </section>
      </div>
    </ScrollArea>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col justify-center gap-1.5 px-4 py-5">
      <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{label}</span>
      <span className="font-mono text-2xl leading-none font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function MetricTile({
  delay = 0,
  hint,
  label,
  meter,
  tone,
  value
}: {
  delay?: number;
  hint?: string;
  label: string;
  meter?: number;
  tone: Tone;
  value: string;
}) {
  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm transition-shadow duration-500 hover:shadow-md"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 rounded-full", toneDot[tone])} />
        <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{label}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-3xl leading-none font-semibold tabular-nums">{value}</span>
        {hint ? <span className="font-mono text-xs text-muted-foreground tabular-nums">{hint}</span> : null}
      </div>
      <div className="mt-auto pt-1">{meter === undefined ? <div className="h-1.5" /> : <Meter tone={tone} value={meter} />}</div>
    </div>
  );
}

function Meter({ tone, value }: { tone: Tone; value: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-[width] duration-700 ease-out", toneBar[tone])}
        style={{ width: `${clampPercent(value)}%` }}
      />
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
