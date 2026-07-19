import { z } from "zod";

export const appViewSchema = z.enum([
  "graph",
  "canvas-map",
  "review-pipeline",
  "todo",
  "statistics",
  "search",
  "notifications",
  "settings",
  "task-workspace"
]);

export const regularAppViewSchema = appViewSchema.exclude(["task-workspace"]);
export const graphAppViewSchema = regularAppViewSchema.extract(["graph"]);
export const nonGraphRegularAppViewSchema = regularAppViewSchema.exclude(["graph"]);

export type AppView = z.output<typeof appViewSchema>;
export type RegularAppView = z.output<typeof regularAppViewSchema>;
