import { describe, expect, it } from "vitest";
import { readMcpConfig } from "../config.js";

describe("readMcpConfig", () => {
  it("uses secure local defaults", () => {
    expect(readMcpConfig({})).toEqual({
      host: "127.0.0.1",
      maxRequestBodyBytes: 1_048_576,
      oauth: undefined,
      port: 8787,
      token: undefined,
      planweaveHomeFromEnv: false
    });
  });

  it("reads host, port, token, and PLANWEAVE_HOME presence from env", () => {
    expect(
      readMcpConfig({
        PLANWEAVE_MCP_HOST: " 127.0.0.1 ",
        PLANWEAVE_MCP_MAX_BODY_BYTES: "2048",
        PLANWEAVE_MCP_OAUTH_ENABLED: "true",
        PLANWEAVE_MCP_PORT: "9001",
        PLANWEAVE_MCP_TOKEN: " secret-token ",
        PLANWEAVE_HOME: "/tmp/planweave-home"
      })
    ).toEqual({
      host: "127.0.0.1",
      maxRequestBodyBytes: 2048,
      oauth: {
        enabled: true
      },
      port: 9001,
      token: "secret-token",
      planweaveHomeFromEnv: true
    });
  });

  it("rejects invalid ports", () => {
    expect(() => readMcpConfig({ PLANWEAVE_MCP_PORT: "0" })).toThrow("PLANWEAVE_MCP_PORT");
    expect(() => readMcpConfig({ PLANWEAVE_MCP_PORT: "65536" })).toThrow("PLANWEAVE_MCP_PORT");
    expect(() => readMcpConfig({ PLANWEAVE_MCP_PORT: "not-a-port" })).toThrow("PLANWEAVE_MCP_PORT");
  });

  it("rejects invalid MCP request body limits", () => {
    expect(() => readMcpConfig({ PLANWEAVE_MCP_MAX_BODY_BYTES: "0" })).toThrow("PLANWEAVE_MCP_MAX_BODY_BYTES");
    expect(() => readMcpConfig({ PLANWEAVE_MCP_MAX_BODY_BYTES: "10485761" })).toThrow("PLANWEAVE_MCP_MAX_BODY_BYTES");
    expect(() => readMcpConfig({ PLANWEAVE_MCP_MAX_BODY_BYTES: "not-bytes" })).toThrow("PLANWEAVE_MCP_MAX_BODY_BYTES");
  });

  it("requires token auth when binding outside loopback", () => {
    expect(() => readMcpConfig({ PLANWEAVE_MCP_HOST: "0.0.0.0" })).toThrow("PLANWEAVE_MCP_TOKEN");
    expect(readMcpConfig({ PLANWEAVE_MCP_HOST: "0.0.0.0", PLANWEAVE_MCP_TOKEN: "secret" })).toMatchObject({
      host: "0.0.0.0",
      token: "secret"
    });
    expect(readMcpConfig({ PLANWEAVE_MCP_HOST: "0.0.0.0", PLANWEAVE_MCP_OAUTH_ENABLED: "1" })).toMatchObject({
      host: "0.0.0.0",
      oauth: {
        enabled: true
      }
    });
  });

  it("rejects invalid OAuth flag values", () => {
    expect(() => readMcpConfig({ PLANWEAVE_MCP_OAUTH_ENABLED: "maybe" })).toThrow("PLANWEAVE_MCP_OAUTH_ENABLED");
  });

  it("reads the OAuth client store path", () => {
    expect(
      readMcpConfig({
        PLANWEAVE_MCP_OAUTH_ENABLED: "true",
        PLANWEAVE_MCP_OAUTH_CLIENT_STORE: " /tmp/planweave-oauth-clients.json ",
        PLANWEAVE_MCP_OAUTH_TOKEN_STORE: " /tmp/planweave-oauth-tokens.json "
      }).oauth
    ).toEqual({
      enabled: true,
      clientStorePath: "/tmp/planweave-oauth-clients.json",
      tokenStorePath: "/tmp/planweave-oauth-tokens.json"
    });
  });

  it("reads optional OAuth redirect URI prefixes", () => {
    expect(
      readMcpConfig({
        PLANWEAVE_MCP_OAUTH_ENABLED: "true",
        PLANWEAVE_MCP_OAUTH_REDIRECT_URI_PREFIXES: " https://chat.openai.com/,https://chatgpt.com/ "
      }).oauth
    ).toEqual({
      enabled: true,
      redirectUriPrefixes: ["https://chat.openai.com/", "https://chatgpt.com/"]
    });
  });

  it("reads explicit MCP tool discovery mode", () => {
    expect(readMcpConfig({ PLANWEAVE_MCP_TOOL_DISCOVERY: "compat" })).toMatchObject({ toolDiscoveryMode: "compat" });
    expect(() => readMcpConfig({ PLANWEAVE_MCP_TOOL_DISCOVERY: "all" })).toThrow("PLANWEAVE_MCP_TOOL_DISCOVERY");
  });
});
