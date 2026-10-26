import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { channelsListCommand } from "../commands/channels/list.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";

const testState = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  json: [] as unknown[],
  catalogEntries: [] as ChannelPluginCatalogEntry[],
}));

vi.mock("../commands/channels/shared.js", () => ({
  formatChannelAccountLabel: vi.fn(),
  requireValidChannelConfig: vi.fn(async () => testState.config),
}));
vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: vi.fn(() => testState.catalogEntries),
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => undefined),
  resolveDefaultAgentId: vi.fn(() => "main"),
  tryResolveConfiguredAgentWorkspaceDir: vi.fn(() => undefined),
  tryResolveSystemAgentWorkspaceDir: vi.fn(() => undefined),
}));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channels-list-catalog-rows-"));
const listJson = (all = false) =>
  channelsListCommand(
    { json: true, all },
    {
      ...createTestRuntime(),
      writeJson: (value: unknown) => testState.json.push(value),
    },
  );

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  testState.json = [];
  testState.catalogEntries = [];
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
});

it("renders named channel accounts without loading setup or runtime", async () => {
  const pluginRoot = path.join(tempRoot, "named");
  fs.mkdirSync(pluginRoot, { recursive: true });
  const setupMarker = path.join(pluginRoot, "setup-loaded.txt");
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "cold-channel-plugin",
    channelId: "cold-channel",
    setupEntrySource: `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded");
throw new Error("JSON inventory must not execute setup");`,
  });
  testState.config = {
    channels: {
      "cold-channel": {
        accounts: { alerts: { token: "configured" }, default: { token: "configured" } },
      },
    },
    ...createColdPluginConfig(pluginRoot, fixture.pluginId),
  };
  await listJson();
  await listJson(true);
  const expected = {
    chat: {
      "cold-channel": {
        label: "Cold Control Plane",
        accounts: ["alerts", "default"],
        installed: true,
        origin: "configured",
      },
    },
  };
  expect(testState.json).toEqual([expected, expected]);
  expect(fs.existsSync(setupMarker)).toBe(false);
  expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("lists a configured catalog channel whose plugin is missing", async () => {
  testState.catalogEntries = [
    {
      id: "feishu",
      meta: { label: "Feishu" },
      install: { npmSpec: "@openclaw/feishu" },
    } as ChannelPluginCatalogEntry,
  ];
  testState.config = { channels: { feishu: { enabled: true } } } as OpenClawConfig;
  await listJson();
  expect(testState.json).toEqual([
    { chat: { feishu: { label: "Feishu", accounts: [], installed: false, origin: "configured" } } },
  ]);
});
