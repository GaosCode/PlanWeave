import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const treeRegionExitMs = 180;
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

type AnimatedTreeRegionProps = {
  children: ReactNode;
  className: string;
  expanded: boolean;
  unmountOnExit?: boolean;
};

function shouldSkipExitAnimation() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(reducedMotionQuery).matches;
}

export function AnimatedTreeRegion({ children, className, expanded, unmountOnExit = false }: AnimatedTreeRegionProps) {
  const [shouldRender, setShouldRender] = useState(() => expanded || !unmountOnExit);

  useEffect(() => {
    if (!unmountOnExit) {
      setShouldRender(true);
      return;
    }
    if (expanded) {
      setShouldRender(true);
      return;
    }
    if (shouldSkipExitAnimation()) {
      setShouldRender(false);
      return;
    }
    const exitTimer = window.setTimeout(() => setShouldRender(false), treeRegionExitMs);
    return () => window.clearTimeout(exitTimer);
  }, [expanded, unmountOnExit]);

  if (!expanded && !shouldRender) {
    return null;
  }

  return (
    <div
      aria-hidden={!expanded}
      className={cn(
        "grid min-w-0 transition-[grid-template-rows,opacity,transform] duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)]",
        expanded ? "grid-rows-[1fr] translate-y-0 opacity-100" : "pointer-events-none grid-rows-[0fr] -translate-y-1 opacity-0"
      )}
      inert={expanded ? undefined : true}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
