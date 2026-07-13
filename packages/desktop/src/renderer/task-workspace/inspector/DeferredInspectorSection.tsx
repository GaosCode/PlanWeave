import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

export function DeferredInspectorSection({
  count,
  empty,
  label,
  renderContent
}: {
  count: number;
  empty: string;
  label: string;
  renderContent: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="group border-b border-border/80"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-xs font-semibold tracking-wide text-text-muted uppercase outline-none hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 transition-transform group-open:rotate-90"
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="font-mono text-[10px] tabular-nums">{count}</span>
      </summary>
      {open ? (
        <div className="px-3 pb-3">
          {count === 0 ? <p className="text-xs text-text-muted">{empty}</p> : renderContent()}
        </div>
      ) : null}
    </details>
  );
}
