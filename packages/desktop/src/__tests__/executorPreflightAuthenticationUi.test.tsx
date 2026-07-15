/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutorPreflightSummary } from "../renderer/components/ExecutorPreflightSummary";
import { createTranslator } from "../renderer/i18n";

const t = createTranslator("en");

afterEach(cleanup);

describe("executor preflight authentication UI", () => {
  it.each([
    {
      reason: "missing_credentials" as const,
      methods: [
        {
          id: "env-login",
          name: "Environment login",
          type: "env_var" as const,
          requiredVariables: ["SAFE_API_KEY"],
          missingVariables: ["SAFE_API_KEY"],
          link: "https://agent.example.com/login"
        }
      ],
      expected: [
        "Required credentials are missing.",
        "SAFE_API_KEY",
        "https://agent.example.com/login"
      ]
    },
    {
      reason: "interactive_method" as const,
      methods: [{ id: "terminal-login", name: "Terminal login", type: "terminal" as const }],
      expected: [
        "terminal or interactive user action",
        "Terminal login",
        "PlanWeave will not run it automatically"
      ]
    },
    {
      reason: "no_safe_method" as const,
      methods: [{ id: "agent-login", name: "Agent login", type: "agent" as const }],
      expected: [
        "headless-safe authentication method",
        "Agent login",
        "PlanWeave will not start it automatically"
      ]
    }
  ])("renders actionable $reason authentication without secrets", ({
    reason,
    methods,
    expected
  }) => {
    render(
      <ExecutorPreflightSummary
        result={{
          agentInfo: null,
          authentication: { status: "action_required", reason, methods },
          checks: [
            { check: "acp_initialized", status: "passed", message: "ACP initialize completed." }
          ]
        }}
        t={t}
      />
    );

    const summary = screen.getByTestId("executor-preflight-summary");
    expect(summary).toHaveTextContent("Initialized successfully");
    expect(summary).toHaveTextContent("Not provided by the agent");
    expect(summary).toHaveTextContent("After login or configuration is complete, test again.");
    for (const fragment of expected) {
      expect(summary).toHaveTextContent(fragment);
    }
    expect(summary).not.toHaveTextContent("secret-value");
    expect(summary).not.toHaveTextContent("permission");
    expect(summary).not.toHaveTextContent("elicitation");
    const link = screen.queryByTestId("authentication-link");
    if (link) {
      expect(link.closest("a")).toBeNull();
    }
  });

  it("renders authenticated and not-advertised states without inventing methods", () => {
    const { rerender } = render(
      <ExecutorPreflightSummary
        result={{
          agentInfo: { name: "Grok", version: "0.2.101" },
          authentication: { status: "authenticated", methodId: "cached_token" },
          checks: [
            { check: "acp_initialized", status: "passed", message: "ACP initialize completed." }
          ]
        }}
        t={t}
      />
    );

    expect(screen.getByTestId("executor-preflight-summary")).toHaveTextContent(
      "Authenticated with method cached_token"
    );
    expect(screen.queryByTestId("authentication-methods")).not.toBeInTheDocument();

    rerender(
      <ExecutorPreflightSummary
        result={{
          agentInfo: null,
          authentication: { status: "not_advertised" },
          checks: [
            { check: "acp_initialized", status: "passed", message: "ACP initialize completed." }
          ]
        }}
        t={t}
      />
    );
    expect(screen.getByTestId("executor-preflight-summary")).toHaveTextContent(
      "Not advertised; protocol authentication was not invoked"
    );
  });
});
