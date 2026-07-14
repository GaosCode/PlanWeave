import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

type VerticalResizeHandleProps = ComponentPropsWithoutRef<"div"> & {
  side: "left" | "right";
  visualTopInset?: boolean;
};

export function VerticalResizeHandle({
  className,
  side,
  visualTopInset = false,
  ...props
}: VerticalResizeHandleProps) {
  return (
    <div
      {...props}
      className={cn(
        "app-no-drag absolute inset-y-0 z-20 w-2 cursor-col-resize bg-transparent after:pointer-events-none after:absolute after:w-px after:bg-border/80 after:transition-colors after:duration-[var(--motion-duration-fast)] after:ease-[var(--motion-ease-standard)] hover:after:bg-foreground/30 focus-visible:outline-none focus-visible:after:bg-foreground/35 active:after:bg-foreground/50",
        visualTopInset ? "after:top-11 after:bottom-0" : "after:inset-y-0",
        side === "left" ? "left-0 after:left-0" : "right-0 after:right-0",
        className
      )}
    />
  );
}
