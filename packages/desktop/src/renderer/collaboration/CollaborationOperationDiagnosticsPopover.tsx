import { useEffect, useMemo, useState } from "react";
import type { CollaborationOperationDiagnosticEntry } from "../../shared/collaborationOperationDiagnostics.js";
import {
  useCollaborationOperationDiagnostics,
  type CollaborationOperationDiagnosticsApi
} from "../hooks/useCollaborationOperationDiagnostics.js";

type CollaborationOperationDiagnosticsPopoverProps = {
  api?: CollaborationOperationDiagnosticsApi | null;
  enabled: boolean;
};

const COPY = {
  en: {
    title: "Collaboration status",
    restoring: "restoring",
    ready: "ready",
    failed: "recovery failed",
    unavailable: "diagnostics unavailable",
    loading: "loading diagnostics",
    idle: "queue idle",
    startup: "Startup recovery",
    queue: "Main coordination queue",
    queued: "queued"
  },
  zh: {
    title: "协作状态",
    restoring: "恢复中",
    ready: "已就绪",
    failed: "恢复失败",
    unavailable: "诊断不可用",
    loading: "读取诊断中",
    idle: "队列空闲",
    startup: "启动恢复",
    queue: "主协调队列",
    queued: "等待"
  }
} as const;

function elapsedSeconds(entry: CollaborationOperationDiagnosticEntry | null, now: number): number {
  if (!entry?.startedAt) return 0;
  return Math.max(0, Math.floor((now - Date.parse(entry.startedAt)) / 1_000));
}

export function CollaborationOperationDiagnosticsPopover({
  api,
  enabled
}: CollaborationOperationDiagnosticsPopoverProps) {
  const { diagnostics, unavailable } = useCollaborationOperationDiagnostics({ enabled, api });
  const [now, setNow] = useState(() => Date.now());
  const active = diagnostics?.coordinationQueue.active ?? null;
  const copy =
    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")
      ? COPY.zh
      : COPY.en;

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const startupLabel = useMemo(() => {
    switch (diagnostics?.startup.phase) {
      case "restoring":
        return copy.restoring;
      case "ready":
        return copy.ready;
      case "failed":
        return copy.failed;
      default:
        return unavailable ? copy.unavailable : copy.loading;
    }
  }, [copy, diagnostics?.startup.phase, unavailable]);

  if (!enabled) return null;

  const queue = diagnostics?.coordinationQueue;
  const activeSeconds = elapsedSeconds(active, now);
  const summary = active
    ? `${startupLabel} · ${active.name} · ${activeSeconds}s · ${queue?.queued.length ?? 0} ${copy.queued}`
    : `${startupLabel} · ${queue?.depth ? `${queue.depth} ${copy.queued}` : copy.idle}`;

  return (
    <details
      className="absolute left-1/2 top-12 z-30 w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-border bg-surface/95 text-xs text-text-muted shadow-md backdrop-blur"
      data-testid="collaboration-operation-diagnostics"
    >
      <summary className="cursor-pointer select-none px-3 py-2 font-medium text-text-strong">
        {copy.title} · {summary}
      </summary>
      <div className="grid gap-3 border-t border-border px-3 py-3 font-mono text-[11px] leading-5">
        <div>
          <span className="font-semibold text-text-strong">{copy.startup}</span>
          <div>phase={diagnostics?.startup.phase ?? "unknown"}</div>
          <div>started_at={diagnostics?.startup.startedAt ?? "unknown"}</div>
          <div>error_code={diagnostics?.startup.errorCode ?? "none"}</div>
        </div>
        <div>
          <span className="font-semibold text-text-strong">{copy.queue}</span>
          <div>depth={queue?.depth ?? 0}</div>
          <div>
            active={active ? `${active.name} (${active.operationId}, ${activeSeconds}s)` : "none"}
          </div>
          <div>queued={queue?.queued.map((entry) => entry.name).join(", ") || "none"}</div>
          <div>
            recent=
            {queue?.recent
              .slice(0, 5)
              .map(
                (entry) =>
                  `${entry.name}:${entry.phase}${entry.errorCode ? `:${entry.errorCode}` : ""}`
              )
              .join(", ") || "none"}
          </div>
        </div>
      </div>
    </details>
  );
}
