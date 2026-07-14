import type { DesktopBridgeApi, DesktopVsCodeDetection } from "@planweave-ai/runtime";
import { ChevronDownIcon, Code2Icon, FolderOpenIcon } from "lucide-react";
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
  "detectVsCode" | "openProjectInVsCode" | "revealProjectInFinder"
>;

function VsCodeIcon({ detection }: { detection: DesktopVsCodeDetection | null }) {
  if (detection?.iconDataUrl) {
    return (
      <img
        alt=""
        className="relative top-px size-5 shrink-0 object-contain"
        src={detection.iconDataUrl}
      />
    );
  }
  return <Code2Icon data-icon="inline-start" />;
}

export type TaskWorkspaceRepositoryActionLabels = {
  openInFileManager: string;
  openInVsCode: string;
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
  const [vsCode, setVsCode] = useState<DesktopVsCodeDetection | null>(null);
  const repositoryAvailable = Boolean(api && repositoryRoot);
  const vsCodeAvailable = Boolean(repositoryAvailable && vsCode?.available);

  useEffect(() => {
    let active = true;
    setVsCode(null);
    if (!api) return () => {
      active = false;
    };
    void api.detectVsCode().then(
      (detection) => {
        if (active) setVsCode(detection);
      },
      (caught: unknown) => {
        if (!active) return;
        setVsCode({
          available: false,
          label: "Visual Studio Code",
          iconDataUrl: null,
          iconUnavailableReason: null,
          unavailableReason: caught instanceof Error ? caught.message : String(caught)
        });
      }
    );
    return () => {
      active = false;
    };
  }, [api]);

  const openRepository = async (open: (path: string) => Promise<void>) => {
    if (!repositoryRoot) return;
    try {
      await open(repositoryRoot);
      onError(null);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="app-no-drag inline-flex items-center" data-testid="task-workspace-repository-actions">
      <Button
        className="gap-1.5 rounded-r-none px-2.5"
        disabled={!vsCodeAvailable}
        onClick={() => {
          if (api) void openRepository(api.openProjectInVsCode.bind(api));
        }}
        size="sm"
        title={
          vsCode?.unavailableReason ?? vsCode?.iconUnavailableReason ?? labels.openInVsCode
        }
        type="button"
        variant="outline"
      >
        <VsCodeIcon detection={vsCode} />
        <span className="hidden leading-none lg:inline">VS Code</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={labels.repositoryActions}
            className="-ml-px rounded-l-none px-2"
            disabled={!repositoryAvailable}
            size="sm"
            type="button"
            variant="outline"
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={!vsCodeAvailable}
            onSelect={() => {
              if (api) void openRepository(api.openProjectInVsCode.bind(api));
            }}
            title={vsCode?.unavailableReason ?? vsCode?.iconUnavailableReason ?? undefined}
          >
            <VsCodeIcon detection={vsCode} />
            {labels.openInVsCode}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              if (api) void openRepository(api.revealProjectInFinder.bind(api));
            }}
          >
            <FolderOpenIcon />
            {labels.openInFileManager}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
