import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "../config/redact-snapshot.js";
import { makeSnapshot } from "../config/redact-snapshot.test-helpers.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { createGatewayTool } from "./tools/gateway-tool.js";

const { callGatewayToolMock, readGatewayCallOptionsMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
  readGatewayCallOptionsMock: vi.fn(() => ({})),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: readGatewayCallOptionsMock,
}));

const readConfig = (path?: string) =>
  createGatewayTool().execute("config-read", { action: "config.get", path });
const readSchema = (path: string) =>
  createGatewayTool().execute("schema-read", { action: "config.schema.lookup", path });
const expectSchemaRequest = (path: string) =>
  expect(
    callGatewayToolMock.mock.calls.find(([method]) => method === "config.schema.lookup")?.[2],
  ).toEqual({ path });

describe("gateway tool", () => {
  afterEach(resetCodeModeTestState);

  beforeEach(() => {
    callGatewayToolMock.mockClear();
    readGatewayCallOptionsMock.mockClear();
    callGatewayToolMock.mockImplementation(async (method: string) =>
      method === "config.get" ? { config: { tools: {} } } : { ok: true },
    );
  });

  it("preserves scoped redacted config.get data through Code Mode", async () => {
    const secret = "fixture-gateway-token-not-live";
    const snapshot = redactConfigSnapshot(
      makeSnapshot({ gateway: { port: 19_001, auth: { token: secret } } }),
      { "gateway.auth.token": { sensitive: true } },
    );
    callGatewayToolMock.mockResolvedValue(snapshot);
    const gateway = createGatewayTool();
    const direct = await gateway.execute("direct-config", {
      action: "config.get",
      path: "gateway",
    });
    const expected = {
      ok: true,
      result: {
        hash: "abc123",
        path: "gateway",
        config: { port: 19_001, auth: { token: REDACTED_SENTINEL } },
      },
    };
    expect(direct.details).toEqual(expected);
    expect(direct.content).toEqual([{ type: "text", text: JSON.stringify(expected, null, 2) }]);
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, gateway] });
    const bridged = resultDetails(
      await h.tools[0]!.execute("config-through-code", {
        code: 'return await gateway({ action: "config.get", path: "gateway" });',
      }),
    );
    expect(bridged).toMatchObject({ status: "completed", value: expected });
    expect(JSON.stringify(bridged)).not.toContain(secret);
  });

  it.each(["tools.missing", "...", "constructor.prototype"])(
    "rejects invalid config.get path %s",
    async (path) => {
      await expect(readConfig(path)).rejects.toThrow(`config path not found: ${path}`);
    },
  );

  it("reads config.get paths with bracketed array indexes", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      config: { agents: { entries: { ops: { skills: ["deploy"] } } } },
    });

    const path = "agents.entries.ops.skills[0]";
    expect((await readConfig(path)).content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ ok: true, result: { path, config: "deploy" } }, null, 2),
      },
    ]);
  });

  it("requires a narrower config.get path for oversized output", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      config: { oversized: "x".repeat(100_000) },
    });

    await expect(readConfig()).rejects.toThrow(
      "config.get response is too large; use path to request a narrower config subtree",
    );
  });

  it("returns a path-scoped schema lookup result", async () => {
    const schema = {
      path: "gateway.auth",
      children: [{ key: "token", required: true }],
    };
    callGatewayToolMock.mockResolvedValueOnce(structuredClone(schema));
    const result = await readSchema("gateway.auth");
    expectSchemaRequest("gateway.auth");
    expect(result.details).toMatchObject({ ok: true, result: schema });
  });

  it("returns an in-band schema lookup miss for unknown paths", async () => {
    callGatewayToolMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "config schema path not found",
      }),
    );

    const result = await readSchema("agents.main.authorizedSenders");
    expectSchemaRequest("agents.main.authorizedSenders");
    expect(result.details).toEqual({
      ok: false,
      code: "schema_path_not_found",
      path: "agents.main.authorizedSenders",
      message: "config schema path not found",
    });
  });
});
