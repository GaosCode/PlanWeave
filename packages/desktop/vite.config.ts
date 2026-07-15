import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const maxRendererChunkBytes = 500_000;

function enforceRendererChunkBudget(): Plugin {
  let oversized: string[] = [];
  return {
    name: "planweave-renderer-chunk-budget",
    generateBundle(_options, bundle) {
      oversized = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const bytes = Buffer.byteLength(output.code);
        if (bytes > maxRendererChunkBytes) {
          oversized.push(`${output.fileName} (${bytes} bytes)`);
        }
      }
    },
    closeBundle() {
      if (oversized.length > 0) {
        this.error(
          `Renderer chunks exceed the ${maxRendererChunkBytes}-byte budget:\n${oversized.join("\n")}`
        );
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
          includeDependenciesRecursively: false,
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
              test: (id) => id.includes("@xyflow/react"),
              priority: 20
            },
            {
              name: "ui-vendor",
              test: (id) => id.includes("radix-ui") || id.includes("lucide-react"),
              priority: 10
            }
          ]
        }
      }
    }
  }
});
