import { useMemo } from "react";
import type { DesktopBlockPreview } from "@planweave/runtime";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type BlockConnectionsCardProps = {
  blocks: DesktopBlockPreview[];
  dependencies: string[];
  onBlockSelect: (ref: string) => Promise<void>;
  selectedBlockRef: string;
};

export function BlockConnectionsCard({ blocks, dependencies, onBlockSelect, selectedBlockRef }: BlockConnectionsCardProps) {
  const dependencyRefs = useMemo(() => new Set(dependencies), [dependencies]);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Block 连接</CardTitle>
        <CardDescription>{selectedBlockRef}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        <div className="flex flex-wrap gap-1">
          {blocks.map((block, index) => {
            const selected = block.ref === selectedBlockRef;
            return (
              <Badge
                asChild
                className={cn("cursor-pointer", selected ? "" : "hover:bg-muted")}
                variant={selected ? "default" : dependencyRefs.has(block.ref) ? "secondary" : "outline"}
                key={block.ref}
              >
                <button type="button" onClick={() => void onBlockSelect(block.ref)}>
                  {index + 1}. {block.blockId}
                </button>
              </Badge>
            );
          })}
        </div>
        <div className="text-muted-foreground">依赖: {dependencies.length > 0 ? dependencies.join(" -> ") : "无"}</div>
      </CardContent>
    </Card>
  );
}
