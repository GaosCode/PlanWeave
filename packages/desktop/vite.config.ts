import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const maxRendererChunkBytes = 500_000;
export const maxRendererEntryChunkBytes = 450_000;
export const maxSettingsRouteChunkBytes = 75_000;
export const appSettingsRouteModuleId = resolve(
  __dirname,
  "src",
  "renderer",
  "AppSettingsRoute.tsx"
).replaceAll("\\", "/");

export type RendererChunk = {
  type: "chunk";
  code: string;
  facadeModuleId: string | null;
  fileName: string;
  isEntry: boolean;
  modules: Record<string, unknown>;
};

function normalizeModuleId(moduleId: string): string {
  return moduleId.replaceAll("\\", "/");
}

export function isAppSettingsRouteChunk(chunk: RendererChunk): boolean {
  return [chunk.facadeModuleId, ...Object.keys(chunk.modules)].some(
    (moduleId) => moduleId !== null && normalizeModuleId(moduleId) === appSettingsRouteModuleId
  );
}

export function rendererChunkBudgetViolations(chunks: Iterable<RendererChunk>): string[] {
  const violations: string[] = [];
  const settingsRouteChunks: RendererChunk[] = [];

  for (const chunk of chunks) {
    const bytes = Buffer.byteLength(chunk.code);
    if (chunk.isEntry && bytes > maxRendererEntryChunkBytes) {
      violations.push(
        `${chunk.fileName} (${bytes} bytes) exceeds the renderer entry chunk budget.`
      );
    }
    if (bytes > maxRendererChunkBytes) {
      violations.push(`${chunk.fileName} (${bytes} bytes) exceeds the renderer chunk budget`);
    }
    if (isAppSettingsRouteChunk(chunk)) {
      settingsRouteChunks.push(chunk);
    }
  }

  if (settingsRouteChunks.length !== 1) {
    violations.push(
      `Expected exactly one AppSettingsRoute chunk, found ${settingsRouteChunks.length}.`
    );
    return violations;
  }

  const [settingsRouteChunk] = settingsRouteChunks;
  if (settingsRouteChunk.isEntry) {
    violations.push("AppSettingsRoute must be emitted as a non-entry chunk.");
  }
  const settingsRouteBytes = Buffer.byteLength(settingsRouteChunk.code);
  if (settingsRouteBytes > maxSettingsRouteChunkBytes) {
    violations.push(
      `${settingsRouteChunk.fileName} (${settingsRouteBytes} bytes) exceeds the AppSettingsRoute budget.`
    );
  }

  return violations;
}

export function enforceRendererChunkBudget(): Plugin {
  let violations: string[] = [];
  return {
    name: "planweave-renderer-chunk-budget",
    generateBundle(_options, bundle) {
      const chunks: RendererChunk[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        chunks.push({
          type: output.type,
          code: output.code,
          facadeModuleId: output.facadeModuleId,
          fileName: output.fileName,
          isEntry: output.isEntry,
          modules: output.modules
        });
      }
      violations = rendererChunkBudgetViolations(chunks);
    },
    closeBundle() {
      if (violations.length > 0) {
        this.error(`Renderer bundle contract failed:\n${violations.join("\n")}`);
      }
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), enforceRendererChunkBudget()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src", "renderer")
    }
  },
  root: ".",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: true,
          groups: [
            {
              name: "react-vendor",
              test: (id) =>
                id.includes("/node_modules/react/") ||
                id.includes("/node_modules/react-dom/") ||
                id.includes("/node_modules/scheduler/"),
              priority: 40
            },
            {
              name: "schema-vendor",
              test: (id) => id.includes("/node_modules/zod/"),
              priority: 30
            },
            {
              name: "flow-vendor",
              test: (id) => id.includes("/node_modules/@xyflow/"),
              priority: 20
            },
            {
              name: "ui-vendor",
              test: (id) => id.includes("radix-ui") || id.includes("lucide-react"),
              priority: 10
            },
            {
              // Keep collaboration surfaces out of the main shell chunk so graph/todo
              // assignee projections can land without breaching the renderer budget.
              name: "collaboration",
              test: (id) =>
                id.includes("/renderer/collaboration/") ||
                id.includes("/renderer/team/") ||
                id.includes("/renderer/hooks/useCollaboration") ||
                id.includes("/renderer/hooks/useAssignee") ||
                id.includes("/renderer/hooks/usePeople") ||
                id.includes("/shared/collaboration") ||
                id.includes("@planweave-ai/collaboration-protocol"),
              priority: 12
            },
            {
              // Task Workspace state is shared by the shell and its lazy detail route.
              // Keep that feature boundary out of the renderer entry without duplicating it.
              name: "task-workspace",
              test: (id) =>
                id.includes("/renderer/task-workspace/") ||
                id.endsWith("/renderer/taskWorkspaceNavigation.ts"),
              priority: 13
            },
            {
              // Settings is a secondary route with several independent administration
              // surfaces. Keep it out of the startup shell while preserving its lazy
              // Host administration boundary.
              name: "settings",
              test: (id) =>
                id.includes("/renderer/settings/") ||
                id.endsWith("/renderer/views/SettingsView.tsx"),
              priority: 11
            }
          ]
        }
      }
    }
  }
});
