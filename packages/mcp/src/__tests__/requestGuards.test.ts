import { IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { McpConfig } from "../config.js";
import { isRequestOriginAllowed } from "../requestGuards.js";

type RequestGuardConfig = Pick<McpConfig, "host" | "port" | "trustForwardedHeaders">;

const defaultConfig: RequestGuardConfig = {
  host: "127.0.0.1",
  port: 8787,
  trustForwardedHeaders: false
};

function guardRequest(
  headers: IncomingHttpHeaders,
  config: RequestGuardConfig = defaultConfig,
  options: { encrypted?: boolean; remoteAddress?: string } = {}
) {
  const socket = new Socket();
  if (options.encrypted) {
    Object.defineProperty(socket, "encrypted", { value: true });
  }
  if (options.remoteAddress) {
    Object.defineProperty(socket, "remoteAddress", { value: options.remoteAddress });
  }
  const request = new IncomingMessage(socket);
  request.headers = headers;
  const result = isRequestOriginAllowed(request, config);
  request.destroy();
  return result;
}

describe("MCP request guards", () => {
  it("rejects a loopback alias Origin that differs from the actual Host", () => {
    expect(
      guardRequest({
        host: "127.0.0.1:8787",
        origin: "http://localhost:8787"
      })
    ).toEqual({ ok: false, error: "invalid_origin" });
  });

  it("rejects an HTTPS Origin for an HTTP request with the same Host and port", () => {
    expect(
      guardRequest({
        host: "127.0.0.1:8787",
        origin: "https://127.0.0.1:8787"
      })
    ).toEqual({ ok: false, error: "invalid_origin" });
  });

  it("allows an exact same-origin request and a request without Origin", () => {
    expect(
      guardRequest({
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787"
      })
    ).toEqual({ ok: true });
    expect(guardRequest({ host: "127.0.0.1:8787" })).toEqual({ ok: true });
  });

  it("normalizes hostname case, IPv6 spelling, and default ports like URL origins", () => {
    expect(
      guardRequest(
        { host: "LOCALHOST", origin: "http://localhost:80" },
        { host: "localhost", port: 80, trustForwardedHeaders: false }
      )
    ).toEqual({ ok: true });
    expect(
      guardRequest(
        {
          host: "[0:0:0:0:0:0:0:1]:8787",
          origin: "http://[::1]:8787"
        },
        { host: "::1", port: 8787, trustForwardedHeaders: false }
      )
    ).toEqual({ ok: true });
    expect(
      guardRequest(
        { host: "LOCALHOST", origin: "https://localhost:443" },
        { host: "localhost", port: 443, trustForwardedHeaders: false },
        { encrypted: true }
      )
    ).toEqual({ ok: true });
  });

  it.each([
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1"
  ])("uses a trusted forwarded public origin from loopback peer %s", (remoteAddress) => {
    expect(
      guardRequest(
        {
          host: "127.0.0.1:8787",
          origin: "https://tunnel.example",
          "x-forwarded-host": "tunnel.example",
          "x-forwarded-proto": "https"
        },
        { ...defaultConfig, trustForwardedHeaders: true },
        { remoteAddress }
      )
    ).toEqual({ ok: true });
  });

  it("rejects forwarded spoofing when trust is disabled", () => {
    expect(
      guardRequest(
        {
          host: "127.0.0.1:8787",
          origin: "https://tunnel.example",
          "x-forwarded-host": "tunnel.example",
          "x-forwarded-proto": "https"
        },
        defaultConfig,
        { remoteAddress: "127.0.0.1" }
      )
    ).toEqual({ ok: false, error: "invalid_host" });
  });

  it("validates the direct Host before trusted forwarded headers", () => {
    expect(
      guardRequest(
        {
          host: "evil.example",
          origin: "https://tunnel.example",
          "x-forwarded-host": "tunnel.example",
          "x-forwarded-proto": "https"
        },
        { ...defaultConfig, trustForwardedHeaders: true },
        { remoteAddress: "127.0.0.1" }
      )
    ).toEqual({ ok: false, error: "invalid_host" });
  });

  it("rejects forwarded headers from a non-loopback peer", () => {
    expect(
      guardRequest(
        {
          host: "127.0.0.1:8787",
          origin: "https://tunnel.example",
          "x-forwarded-host": "tunnel.example",
          "x-forwarded-proto": "https"
        },
        { ...defaultConfig, trustForwardedHeaders: true },
        { remoteAddress: "192.0.2.10" }
      )
    ).toEqual({ ok: false, error: "invalid_host" });
  });

  it("ignores a forwarded protocol without a host from a trusted loopback proxy", () => {
    expect(
      guardRequest(
        {
          host: "127.0.0.1:8787",
          "x-forwarded-proto": "https"
        },
        { ...defaultConfig, trustForwardedHeaders: true },
        { remoteAddress: "127.0.0.1" }
      )
    ).toEqual({ ok: true });
  });

  it("rejects a protocol-only forwarded header outside the trusted proxy boundary", () => {
    expect(
      guardRequest(
        {
          host: "127.0.0.1:8787",
          "x-forwarded-proto": "https"
        },
        defaultConfig,
        { remoteAddress: "127.0.0.1" }
      )
    ).toEqual({ ok: false, error: "invalid_host" });
    expect(
      guardRequest(
        {
          host: "127.0.0.1:8787",
          "x-forwarded-proto": "https"
        },
        { ...defaultConfig, trustForwardedHeaders: true },
        { remoteAddress: "192.0.2.10" }
      )
    ).toEqual({ ok: false, error: "invalid_host" });
  });

  it.each([
    { forwardedHost: "tunnel.example", forwardedProto: undefined },
    { forwardedHost: undefined, forwardedProto: "ftp" },
    { forwardedHost: "tunnel.example,evil.example", forwardedProto: "https" },
    { forwardedHost: "tunnel.example", forwardedProto: "https,http" },
    { forwardedHost: "tunnel.example", forwardedProto: "ftp" },
    { forwardedHost: "https://tunnel.example/path", forwardedProto: "https" }
  ])("rejects partial or malformed forwarded headers %#", ({ forwardedHost, forwardedProto }) => {
    expect(
      guardRequest(
        {
          host: "127.0.0.1:8787",
          ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
          ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {})
        },
        { ...defaultConfig, trustForwardedHeaders: true },
        { remoteAddress: "127.0.0.1" }
      )
    ).toEqual({ ok: false, error: "invalid_host" });
  });

  it("rejects a cross-origin browser request against the trusted forwarded origin", () => {
    expect(
      guardRequest(
        {
          host: "127.0.0.1:8787",
          origin: "https://evil.example",
          "x-forwarded-host": "tunnel.example",
          "x-forwarded-proto": "https"
        },
        { ...defaultConfig, trustForwardedHeaders: true },
        { remoteAddress: "::1" }
      )
    ).toEqual({ ok: false, error: "invalid_origin" });
  });
});
