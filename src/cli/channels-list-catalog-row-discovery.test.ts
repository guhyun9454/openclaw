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

vi.mock("../plugins/plugin-registry-contributions.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/plugin-registry-contributions.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: vi.fn(
      actual.loadPluginManifestRegistryForPluginRegistry,
    ),
  };
});

vi.mock("../commands/channels/shared.js", () => ({
  formatChannelAccountLabel: vi.fn(),
  requireValidChannelConfig: vi.fn(async () => testState.config),
}));
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry-contributions.js";
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

// Configured official external channels with missing owners exercise row repair hints.
const OWNERLESS_CHANNEL_IDS = ["feishu", "googlechat", "matrix", "twitch"] as const;

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  testState.json = [];
  testState.catalogEntries = [];
  vi.mocked(loadPluginManifestRegistryForPluginRegistry).mockClear();
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
    manifest: {
      channelConfigs: {
        "cold-channel": {
          schema: { type: "object" },
          label: "Cold Channel",
        },
      },
    },
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
        label: "Cold Channel",
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

it("resolves catalog-row repair hints without rebuilding the manifest registry", async () => {
  testState.catalogEntries = OWNERLESS_CHANNEL_IDS.map(
    (id) =>
      ({
        id,
        meta: { label: id },
        install: { npmSpec: `@openclaw/${id}` },
      }) as ChannelPluginCatalogEntry,
  );
  testState.config = {
    channels: Object.fromEntries(OWNERLESS_CHANNEL_IDS.map((id) => [id, { enabled: true }])),
  } as OpenClawConfig;
  await listJson();
  expect(testState.json).toEqual([
    {
      chat: Object.fromEntries(
        OWNERLESS_CHANNEL_IDS.map((channelId) => [
          channelId,
          { label: channelId, accounts: [], installed: false, origin: "configured" },
        ]),
      ),
    },
  ]);
  expect(loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
});
