import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./index.css";
import { App } from "./App.js";
import { BlockInspectorWindow } from "./BlockInspectorWindow.js";

const windowMode = new URLSearchParams(window.location.search).get("window");
const Root = windowMode === "block-inspector" ? BlockInspectorWindow : App;

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
