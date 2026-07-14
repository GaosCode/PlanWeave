import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

type VerticalResizeHandleProps = ComponentPropsWithoutRef<"div"> & {
  side: "left" | "right";
};

export function VerticalResizeHandle({ className, side, ...props }: VerticalResizeHandleProps) {
  return (
    <div
      {...props}
      className={cn(
        "app-no-drag absolute inset-y-0 z-20 w-2 cursor-col-resize bg-transparent after:pointer-events-none after:absolute after:inset-y-0 after:w-px after:bg-border/80 after:transition-colors after:duration-[var(--motion-duration-fast)] after:ease-[var(--motion-ease-standard)] hover:after:bg-foreground/30 focus-visible:outline-none focus-visible:after:bg-foreground/35 active:after:bg-foreground/50",
        side === "left" ? "left-0 after:left-0" : "right-0 after:right-0",
        className
      )}
    />
  );
}
