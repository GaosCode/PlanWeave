import { useEffect, useRef, useState } from "react";

export function useCommentPopoverDismissal(open: boolean, onOpenChange: (open: boolean) => void) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [content, contentRef] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger || !content) return;

    const dismissOutside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (!path.includes(trigger) && !path.includes(content)) {
        onOpenChange(false);
      }
    };
    // Canvas panning intercepts mouse events before the popover's deferred dismissal.
    const ownerDocument = content.ownerDocument;
    ownerDocument.addEventListener("pointerdown", dismissOutside, true);
    return () => ownerDocument.removeEventListener("pointerdown", dismissOutside, true);
  }, [content, open, onOpenChange]);

  return { triggerRef, contentRef };
}
