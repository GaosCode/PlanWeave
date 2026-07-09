import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { runtimeSchemaTopicOrder } from "@planweave-ai/runtime";
import { createGateway, readJson, schemaDocument, schemaDocuments } from "./toolTestHelpers.js";
import { planweaveToolDefinitions } from "../toolDefinitions.js";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import { handlePlanweaveTool } from "../tools.js";

describe("MCP tools: schema", () => {
  it("returns schema documents as JSON text content", async () => {
    const result = readJson(
      await handlePlanweaveTool("get_schema", { topic: "manifest" }, createGateway())
    );

    expect(result).toEqual({
      topic: "manifest",
      documents: {
        manifest: schemaDocument
      }
    });
  });

  it("returns schema topic summaries by default without dumping full schema documents", async () => {
    const result = readJson(await handlePlanweaveTool("get_schema", undefined, createGateway()));

    expect(result).toMatchObject({
      topic: null,
      topics: expect.arrayContaining([
        expect.objectContaining({ name: "manifest", summary: schemaDocuments.manifest.summary }),
        expect.objectContaining({ name: "state", summary: schemaDocuments.state.summary }),
        expect.objectContaining({ name: "layout", summary: schemaDocuments.layout.summary })
      ]),
      documents: {}
    });
    expect(JSON.stringify(result)).not.toContain('"schema"');
  });

  it("returns state and layout schema documents by topic", async () => {
    await expect(
      readJson(await handlePlanweaveTool("get_schema", { topic: "state" }, createGateway()))
    ).toEqual({
      topic: "state",
      documents: {
        state: schemaDocuments.state
      }
    });
    await expect(
      readJson(await handlePlanweaveTool("get_schema", { topic: "layout" }, createGateway()))
    ).toEqual({
      topic: "layout",
      documents: {
        layout: schemaDocuments.layout
      }
    });
  });

  it("reports the complete runtime schema topic list for unknown topics", async () => {
    await expect(
      handlePlanweaveTool("get_schema", { topic: "unknown" }, createGateway())
    ).rejects.toThrow(`topic must be one of: ${runtimeSchemaTopicOrder.join(", ")}.`);
  });

  it("uses runtime schema topics in MCP get_schema input and output schemas", () => {
    const inputSchema = z.object(planweaveToolDefinitions.get_schema.inputSchema ?? {});
    const outputSchema = z.object(planweaveToolOutputSchemas.get_schema);

    for (const topic of runtimeSchemaTopicOrder) {
      expect(inputSchema.safeParse({ topic }).success).toBe(true);
      expect(
        outputSchema.safeParse({ topic, documents: { [topic]: schemaDocuments[topic] } }).success
      ).toBe(true);
    }
    expect(outputSchema.safeParse({ topic: null, topics: [], documents: {} }).success).toBe(true);
  });
});
