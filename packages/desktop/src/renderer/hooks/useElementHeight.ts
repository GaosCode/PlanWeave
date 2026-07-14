import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export function useElementHeight<T extends HTMLElement>(): {
  height: number;
  ref: RefObject<T | null>;
} {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateHeight = () => {
      const nextHeight = element.getBoundingClientRect().height;
      setHeight((currentHeight) => currentHeight === nextHeight ? currentHeight : nextHeight);
    };

    updateHeight();
    if (typeof ResizeObserver !== "function") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { height, ref };
}
