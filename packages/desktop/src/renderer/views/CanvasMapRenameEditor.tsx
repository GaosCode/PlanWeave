import type { DesktopCanvasNodeViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { createTranslator } from "../i18n";
import { useInlineRename } from "../hooks/useInlineRename";
import type { TaskCanvasRenameHandler } from "../renameResult";

type CanvasMapRenameEditorProps = {
  canvas: DesktopCanvasNodeViewModel;
  project: DesktopProjectSummary;
  scopeKey: string;
  onClose: () => void;
  onSave: TaskCanvasRenameHandler;
  t: ReturnType<typeof createTranslator>;
};

export function CanvasMapRenameEditor({
  canvas,
  project,
  scopeKey,
  onClose,
  onSave,
  t
}: CanvasMapRenameEditorProps) {
  const rename = useInlineRename({
    active: true,
    name: canvas.title,
    scopeKey,
    onClose,
    onSave: (name, request) => onSave(project, canvas.canvasId, name, request)
  });
  return (
    <Card size="sm">
      <CardContent>
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void rename.commit();
          }}
        >
          <Input
            ref={rename.inputRef}
            aria-label={t("renameTaskCanvasPrompt")}
            aria-busy={rename.pending}
            aria-invalid={rename.failed}
            readOnly={rename.pending}
            value={rename.draft}
            onChange={(event) => rename.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                rename.cancel();
              }
            }}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={rename.pending}>
              {t("save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={rename.cancel}>
              {t("close")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
