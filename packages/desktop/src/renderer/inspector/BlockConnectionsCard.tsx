import { useMemo } from "react";
import type { DesktopBlockPreview } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";

type BlockConnectionsCardProps = {
  blocks: DesktopBlockPreview[];
  dependencies: string[];
  onBlockSelect: (ref: string) => Promise<void>;
  selectedBlockRef: string;
  t: ReturnType<typeof createTranslator>;
};

export function BlockConnectionsCard({
  blocks,
  dependencies,
  onBlockSelect,
  selectedBlockRef,
  t
}: BlockConnectionsCardProps) {
  const dependencyRefs = useMemo(() => new Set(dependencies), [dependencies]);

  return (
    <Card className="shrink-0 overflow-visible" size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{t("blockConnections")}</CardTitle>
        <CardDescription>{selectedBlockRef}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pb-3 text-xs">
        <div className="flex flex-wrap items-center gap-1">
          {blocks.map((block, index) => {
            const selected = block.ref === selectedBlockRef;
            return (
              <Badge
                asChild
                className={cn("cursor-pointer", selected ? "" : "hover:bg-muted")}
                variant={
                  selected ? "default" : dependencyRefs.has(block.ref) ? "secondary" : "outline"
                }
                key={block.ref}
              >
                <button type="button" onClick={() => void onBlockSelect(block.ref)}>
                  {index + 1}. {block.blockId}
                </button>
              </Badge>
            );
          })}
        </div>
        <div className="text-muted-foreground">
          {t("dependencies")}: {dependencies.length > 0 ? dependencies.join(" -> ") : t("none")}
        </div>
      </CardContent>
    </Card>
  );
}
