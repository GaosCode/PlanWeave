import { LockIcon } from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { TaskDispatchState, TaskLockState } from "../types";
import { LOCK_OVERFLOW_LIMIT, lockColor } from "./lockColors";

export type LockBadgeLabels = {
  exclusiveLock: string;
  heldBy: string;
  waitingForResource: string;
  moreLocks: (count: number) => string;
};

export type LockBadgesProps = {
  locks: string[];
  lockStates: Record<string, TaskLockState>;
  dispatchState: TaskDispatchState;
  highlightedLock: string | null;
  releaseEpochByLock: Record<string, number>;
  labels: LockBadgeLabels;
  onLockHover: (name: string | null) => void;
  onLockPin: (name: string | null) => void;
  onOverflowOpen: () => void;
  onJumpToTask: (taskId: string) => void;
};

function parseTaskIdFromRef(ref: string): string {
  return ref.includes("#") ? ref.slice(0, ref.indexOf("#")) : ref;
}

function LockDot({ name, state }: { name: string; state: TaskLockState }) {
  const color = lockColor(name);
  const free = state.kind === "free";
  const heldByThis = state.kind === "heldByThis";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full border",
        free ? "bg-transparent" : null,
        heldByThis ? "animate-pulse" : null
      )}
      data-lock-dot-state={state.kind}
      style={
        {
          borderColor: color.dot,
          backgroundColor: free ? "transparent" : color.dot,
          boxShadow: heldByThis ? `0 0 0 2px ${color.halo}` : undefined
        } satisfies CSSProperties
      }
    />
  );
}

export function LockBadges({
  locks,
  lockStates,
  dispatchState,
  highlightedLock,
  releaseEpochByLock,
  labels,
  onLockHover,
  onLockPin,
  onOverflowOpen,
  onJumpToTask
}: LockBadgesProps) {
  if (locks.length === 0) {
    return null;
  }

  const exclusive = locks.includes("exclusive");
  const visibleLocks = exclusive
    ? (["exclusive"] as string[])
    : locks.slice(0, LOCK_OVERFLOW_LIMIT);
  const overflowCount = exclusive ? 0 : Math.max(0, locks.length - LOCK_OVERFLOW_LIMIT);

  return (
    <div
      className="flex flex-wrap items-center gap-1 px-3 pb-1"
      data-testid="task-node-lock-badges"
    >
      {visibleLocks.map((name) => {
        const state = lockStates[name] ?? { kind: "free" as const };
        const color = lockColor(name);
        const isExclusive = name === "exclusive";
        const releaseEpoch = releaseEpochByLock[name] ?? 0;
        const chipRing = state.kind === "heldElsewhere" ? "ring-1 ring-border" : null;
        const highlighted = highlightedLock === name;
        return (
          <Popover key={name}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-5 max-w-full items-center gap-1 rounded-full border border-border/70 bg-surface-muted px-1.5 text-[10px] font-medium text-text-muted transition-[transform,box-shadow] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] hover:bg-surface-raised",
                  chipRing,
                  highlighted ? "ring-2" : null,
                  releaseEpoch > 0 ? "animate-[lock-release-pulse_250ms_ease-out]" : null
                )}
                data-lock-name={name}
                data-lock-state={state.kind}
                data-testid="task-node-lock-chip"
                style={
                  highlighted
                    ? ({
                        ["--lock-highlight-color" as string]: color.dot,
                        boxShadow: `0 0 0 2px ${color.halo}`
                      } satisfies CSSProperties)
                    : undefined
                }
                onMouseEnter={() => onLockHover(name)}
                onMouseLeave={() => onLockHover(null)}
                onClick={(event: MouseEvent) => {
                  event.stopPropagation();
                  onLockPin(name);
                }}
              >
                {isExclusive ? (
                  <LockIcon className="size-3" aria-hidden="true" />
                ) : (
                  <LockDot name={name} state={state} />
                )}
                <span className="truncate">{isExclusive ? labels.exclusiveLock : name}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64" onClick={(e) => e.stopPropagation()}>
              <PopoverHeader>
                <PopoverTitle className="flex items-center gap-2">
                  <LockDot name={name} state={state} />
                  {isExclusive ? labels.exclusiveLock : name}
                </PopoverTitle>
                <PopoverDescription>
                  {state.kind === "heldByThis"
                    ? labels.heldBy
                    : state.kind === "heldElsewhere"
                      ? labels.heldBy
                      : dispatchState.kind === "waiting" && dispatchState.lock === name
                        ? labels.waitingForResource
                        : name}
                </PopoverDescription>
              </PopoverHeader>
              {state.kind === "heldElsewhere" ? (
                <button
                  type="button"
                  className="mt-1 text-left text-xs font-medium text-state-selected underline-offset-2 hover:underline"
                  data-testid="task-node-lock-holder-jump"
                  onClick={() => onJumpToTask(state.holderTaskId)}
                >
                  {state.holderRef}
                </button>
              ) : null}
              {dispatchState.kind === "waiting" && dispatchState.lock === name ? (
                <div className="mt-2 text-xs text-text-muted" data-testid="task-node-lock-waiting">
                  {labels.waitingForResource}: {dispatchState.holderRef}
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        );
      })}
      {overflowCount > 0 ? (
        <Badge
          asChild
          className="h-5 cursor-pointer border-border/70 bg-surface-muted px-1.5 text-[10px] text-text-muted"
          variant="outline"
          data-testid="task-node-lock-overflow"
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOverflowOpen();
            }}
          >
            {labels.moreLocks(overflowCount)}
          </button>
        </Badge>
      ) : null}
    </div>
  );
}

export function holderTaskIdFromRef(ref: string): string {
  return parseTaskIdFromRef(ref);
}
