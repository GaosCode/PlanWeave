import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

/** A confirmed prompt can advance without replacing an edited draft. */
export function usePromptDraft(
  scope: string,
  markdown: string | null | undefined,
  update: ((markdown: string) => Promise<boolean>) | undefined,
  setError: (message: string | null) => void
) {
  const selection = useMemo(() => ({ scope }), [scope]);
  const lifecycle = useRef({ selection, mounted: false, generation: 0, write: 0, revision: 0 });
  const [draft, setDraft] = useState(markdown ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: authority updates preserve a dirty draft; only selection initializes it.
  useLayoutEffect(() => {
    lifecycle.current.selection = selection;
    lifecycle.current.mounted = true;
    lifecycle.current.generation += 1;
    lifecycle.current.revision = 0;
    setDraft(markdown ?? "");
    setDirty(false);
    setSaving(false);
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.generation += 1;
    };
  }, [selection]);
  useLayoutEffect(() => {
    if (!dirty) setDraft(markdown ?? "");
  }, [dirty, markdown]);
  const edit = useCallback((value: string) => {
    lifecycle.current.revision += 1;
    setDraft(value);
    setDirty(true);
  }, []);
  const save = useCallback(async () => {
    if (!update || !lifecycle.current.mounted || lifecycle.current.selection !== selection) return;
    const generation = lifecycle.current.generation;
    const write = ++lifecycle.current.write;
    const revision = lifecycle.current.revision;
    const current = () =>
      lifecycle.current.mounted &&
      lifecycle.current.selection === selection &&
      lifecycle.current.generation === generation &&
      lifecycle.current.write === write;
    setSaving(true);
    try {
      const accepted = await update(draft);
      if (accepted && current() && lifecycle.current.revision === revision) setDirty(false);
    } catch (caught) {
      if (current()) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (current()) setSaving(false);
    }
  }, [draft, selection, setError, update]);
  return { draft, edit, save, saving };
}
