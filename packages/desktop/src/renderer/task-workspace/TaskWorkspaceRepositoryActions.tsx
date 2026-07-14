import type {
  DesktopBridgeApi,
  DesktopDevelopmentToolDetection
} from "@planweave-ai/runtime";
import { ChevronDownIcon, Code2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

type RepositoryBridge = Pick<
  DesktopBridgeApi,
  "detectDevelopmentTools" | "openProjectInDevelopmentTool"
>;

function DevelopmentToolIcon({ tool }: { tool: DesktopDevelopmentToolDetection | null }) {
  if (tool?.iconDataUrl) {
    return (
      <img
        alt=""
        className="relative top-px size-5 shrink-0 object-contain"
        src={tool.iconDataUrl}
      />
    );
  }
  return <Code2Icon data-icon="inline-start" />;
}

export type TaskWorkspaceRepositoryActionLabels = {
  repositoryActions: string;
};

export function TaskWorkspaceRepositoryActions({
  api,
  labels,
  onError,
  repositoryRoot
}: {
  api: RepositoryBridge | null;
  labels: TaskWorkspaceRepositoryActionLabels;
  onError: (message: string | null) => void;
  repositoryRoot: string | null;
}) {
  const [developmentTools, setDevelopmentTools] = useState<DesktopDevelopmentToolDetection[]>([]);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const availableDevelopmentTools = developmentTools.filter((tool) => tool.available);
  const repositoryAvailable = Boolean(api && repositoryRoot);
  const selectedTool =
    availableDevelopmentTools.find((tool) => tool.toolId === selectedToolId) ??
    availableDevelopmentTools[0] ??
    null;
  const selectedToolAvailable = Boolean(repositoryAvailable && selectedTool);

  useEffect(() => {
    let active = true;
    setDevelopmentTools([]);
    if (!api) return () => {
      active = false;
    };
    void api.detectDevelopmentTools().then(
      (tools) => {
        if (!active) return;
        setDevelopmentTools(tools);
        setSelectedToolId((current) =>
          tools.some((tool) => tool.available && tool.toolId === current)
            ? current
            : (tools.find((tool) => tool.available)?.toolId ?? null)
        );
      },
      (caught: unknown) => {
        if (!active) return;
        setDevelopmentTools([]);
        onError(caught instanceof Error ? caught.message : String(caught));
      }
    );
    return () => {
      active = false;
    };
  }, [api, onError]);

  const openRepository = async (tool: DesktopDevelopmentToolDetection) => {
    if (!api || !repositoryRoot) return;
    try {
      await api.openProjectInDevelopmentTool(repositoryRoot, tool.toolId);
      setSelectedToolId(tool.toolId);
      onError(null);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="app-no-drag inline-flex items-center" data-testid="task-workspace-repository-actions">
      <Button
        className="gap-1.5 rounded-r-none px-2.5"
        disabled={!selectedToolAvailable}
        onClick={() => {
          if (selectedTool) void openRepository(selectedTool);
        }}
        size="sm"
        title={selectedTool?.label}
        type="button"
        variant="outline"
      >
        <DevelopmentToolIcon tool={selectedTool} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={labels.repositoryActions}
            className="-ml-px rounded-l-none px-2"
            disabled={!repositoryAvailable || availableDevelopmentTools.length === 0}
            size="sm"
            type="button"
            variant="outline"
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {availableDevelopmentTools.map((tool) => (
            <DropdownMenuItem
              key={tool.toolId}
              onSelect={() => void openRepository(tool)}
              title={tool.iconUnavailableReason ?? undefined}
            >
              <DevelopmentToolIcon tool={tool} />
              {tool.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
