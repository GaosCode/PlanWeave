import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ComponentProps } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function AutoGrowingTextarea({
  className,
  style,
  value,
  ...props
}: ComponentProps<typeof Textarea> & { value: string }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "0px";
    const borderHeight = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${textarea.scrollHeight + borderHeight}px`;
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
    const animationFrame = window.requestAnimationFrame(resizeTextarea);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [resizeTextarea, value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const parent = textarea?.parentElement;
    if (!textarea || !parent) {
      return;
    }
    const resize = () => resizeTextarea();
    window.addEventListener("resize", resize);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", resize);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [resizeTextarea]);

  return (
    <Textarea
      ref={textareaRef}
      className={cn("overflow-hidden [field-sizing:fixed]", className)}
      style={{ ...style, fieldSizing: "fixed" }}
      value={value}
      {...props}
    />
  );
}
