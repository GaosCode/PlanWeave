import { useCallback, useLayoutEffect, useState, type RefCallback } from "react";

export function useElementHeight<T extends HTMLElement>(): {
  height: number;
  ref: RefCallback<T>;
} {
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState(0);
  const ref = useCallback<RefCallback<T>>((node) => setElement(node), []);

  useLayoutEffect(() => {
    if (!element) {
      setHeight(0);
      return;
    }

    const updateHeight = () => {
      const nextHeight = element.getBoundingClientRect().height;
      setHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
    };

    updateHeight();
    if (typeof ResizeObserver !== "function") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { height, ref };
}
