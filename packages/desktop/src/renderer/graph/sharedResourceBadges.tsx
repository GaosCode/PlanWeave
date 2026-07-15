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
import {
  SHARED_RESOURCE_OVERFLOW_LIMIT,
  sharedResourceColor
} from "./sharedResourceColors";

export type SharedResourceBadgeLabels = {
  sharedResource: string;
  sharedResourceActive: string;
  moreResources: (count: number) => string;
};

export type SharedResourceBadgesProps = {
  resources: string[];
  activeResources: Set<string>;
  highlightedResource: string | null;
  transitionEpochByResource: Record<string, number>;
  labels: SharedResourceBadgeLabels;
  onResourceHover: (name: string | null) => void;
  onResourcePin: (name: string | null) => void;
  onOverflowOpen: () => void;
};

function ResourceDot({ active, name }: { active: boolean; name: string }) {
  const color = sharedResourceColor(name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full border",
        active ? "animate-pulse" : "bg-transparent"
      )}
      data-resource-active={active ? "true" : "false"}
      style={{
        borderColor: color.dot,
        backgroundColor: active ? color.dot : "transparent",
        boxShadow: active ? `0 0 0 2px ${color.halo}` : undefined
      }}
    />
  );
}

export function SharedResourceBadges({
  resources,
  activeResources,
  highlightedResource,
  transitionEpochByResource,
  labels,
  onResourceHover,
  onResourcePin,
  onOverflowOpen
}: SharedResourceBadgesProps) {
  if (resources.length === 0) {
    return null;
  }

  const visibleResources = resources.slice(0, SHARED_RESOURCE_OVERFLOW_LIMIT);
  const overflowCount = Math.max(0, resources.length - SHARED_RESOURCE_OVERFLOW_LIMIT);

  return (
    <div
      className="flex flex-wrap items-center gap-1 px-3 pb-1"
      data-testid="task-node-resource-badges"
    >
      {visibleResources.map((name) => {
        const active = activeResources.has(name);
        const color = sharedResourceColor(name);
        const highlighted = highlightedResource === name;
        const transitionEpoch = transitionEpochByResource[name] ?? 0;
        return (
          <Popover key={name}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "relative inline-flex h-5 max-w-full items-center gap-1 rounded-full border border-border/70 bg-surface-muted px-1.5 text-[10px] font-medium text-text-muted transition-[transform,box-shadow] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] hover:bg-surface-raised",
                  highlighted ? "ring-2" : null
                )}
                data-resource-name={name}
                data-resource-active={active ? "true" : "false"}
                data-testid="task-node-resource-chip"
                style={
                  highlighted
                    ? ({
                        ["--shared-resource-highlight-color" as string]: color.dot,
                        boxShadow: `0 0 0 2px ${color.halo}`
                      } satisfies CSSProperties)
                    : undefined
                }
                onMouseEnter={() => onResourceHover(name)}
                onMouseLeave={() => onResourceHover(null)}
                onClick={(event: MouseEvent) => {
                  event.stopPropagation();
                  onResourcePin(name);
                }}
              >
                {transitionEpoch > 0 ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-full border animate-[shared-resource-transition-pulse_250ms_ease-out]"
                    data-testid="task-node-resource-transition"
                    data-transition-epoch={transitionEpoch}
                    key={`${name}:${transitionEpoch}`}
                    style={{ borderColor: color.dot, boxShadow: `0 0 0 2px ${color.halo}` }}
                  />
                ) : null}
                <ResourceDot active={active} name={name} />
                <span className="truncate">{name}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64" onClick={(event) => event.stopPropagation()}>
              <PopoverHeader>
                <PopoverTitle className="flex items-center gap-2">
                  <ResourceDot active={active} name={name} />
                  {name}
                </PopoverTitle>
                <PopoverDescription>
                  {active ? labels.sharedResourceActive : labels.sharedResource}
                </PopoverDescription>
              </PopoverHeader>
            </PopoverContent>
          </Popover>
        );
      })}
      {overflowCount > 0 ? (
        <Badge
          asChild
          className="h-5 cursor-pointer border-border/70 bg-surface-muted px-1.5 text-[10px] text-text-muted"
          variant="outline"
          data-testid="task-node-resource-overflow"
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOverflowOpen();
            }}
          >
            {labels.moreResources(overflowCount)}
          </button>
        </Badge>
      ) : null}
    </div>
  );
}
