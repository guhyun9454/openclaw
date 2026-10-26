import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const configMocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
}));
const secretsMocks = vi.hoisted(() => ({
  activeSnapshot: null as {
    sourceConfig: OpenClawConfig;
    config: OpenClawConfig;
  } | null,
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  replaceConfigFile: configMocks.replaceConfigFile,
  resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
}));

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/runtime-state.js")>()),
  getActiveSecretsRuntimeSnapshotState: () => secretsMocks.activeSnapshot,
}));

import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  shouldAwaitGatewayConfigApplication,
} from "./config-write-flow.js";

const authConfig = (
  token?: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"],
): OpenClawConfig => ({
  gateway: { auth: { mode: "token", ...(token === undefined ? {} : { token }) } },
});
const runtimeConfig = authConfig("runtime-token");
const authoredConfig = authConfig();
const hookConfig: OpenClawConfig = { hooks: { enabled: true } };
const writeSnapshot = (exists = true) => ({
  path: "/tmp/openclaw.json",
  exists,
  raw: exists ? "{}" : null,
  hash: exists ? "base-hash" : "missing-config-revision",
});
const commit = (exists = true) =>
  commitGatewayConfigWrite({
    snapshot: writeSnapshot(exists) as never,
    writeOptions: {},
    nextConfig: exists ? hookConfig : {},
    ...(exists ? { awaitRuntimeApplication: true } : {}),
  });

const transcriptConfig = (title: string): OpenClawConfig => ({
  transcripts: { autoStart: [{ providerId: "fixture", sessionId: "daily", title }] },
});
const previousConfig = transcriptConfig("Before");
const nextConfig = transcriptConfig("After");
const changedPaths = ["transcripts.autoStart"];
const restartPaths = [...changedPaths, "gateway.port"];
const reloadOffConfig: OpenClawConfig = { ...nextConfig, gateway: { reload: { mode: "off" } } };
it.each([
  ["title edit", previousConfig, nextConfig, changedPaths, true],
  ["transcript addition", {}, nextConfig, changedPaths, true],
  ["restart", previousConfig, nextConfig, restartPaths, false],
  ["disabled reload", previousConfig, reloadOffConfig, changedPaths, false],
] as const)(
  "awaits %s only when the reload owner can apply it",
  (_name, previous, next, paths, awaited) => {
    expect(
      shouldAwaitGatewayConfigApplication({
        previousConfig: previous,
        nextConfig: next,
        changedPaths: paths,
      }),
    ).toBe(awaited);
  },
);

it.each(["hybrid", "off"] as const)("awaits cold-storage settings with %s reload", (mode) => {
  expect(
    shouldAwaitGatewayConfigApplication({
      previousConfig: {},
      nextConfig: {
        gateway: { reload: { mode } },
        session: { maintenance: { coldStorage: { enabled: true, afterDays: 7 } } },
      },
      changedPaths: [
        "session.maintenance.coldStorage.enabled",
        "session.maintenance.coldStorage.afterDays",
      ],
    }),
  ).toBe(mode !== "off");
});

describe("commitGatewayConfigWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.resolveConfigSnapshotHash.mockReturnValue("missing-config-revision");
    configMocks.replaceConfigFile.mockResolvedValue({
      nextConfig: {},
      persistedHash: "persisted-hash",
    });
    secretsMocks.activeSnapshot = null;
  });

  it("carries a missing file revision into the lock-time compare-and-swap", async () => {
    await commit(false);
    expect(configMocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "missing-config-revision",
        sourceConfig: {},
      }),
    );
  });

  it("returns the managed runtime application claimed during the write", async () => {
    configMocks.replaceConfigFile.mockImplementationOnce(async (params) => {
      const application = getRuntimeConfigWriteApplication(params.writeOptions);
      const claim = application?.claim();
      claim?.settle("applied");
      return { nextConfig: hookConfig, persistedHash: "persisted-hash" };
    });
    const result = await commit();
    await expect(result.application).resolves.toBe("applied");
  });

  it("returns an unclaimed required application when no managed reloader is installed", async () => {
    const result = await commit();
    await expect(result.application).resolves.toBe("unclaimed");
  });
});

const tokenA = authConfig("token-a");
const tokenB = authConfig("token-b");
const secretRef = authConfig({ source: "env", provider: "default", id: "GATEWAY_TOKEN" });
it.each([
  ["runtime-only fields", {}, {}, runtimeConfig, runtimeConfig, undefined, false],
  ["stale authored source", tokenA, tokenA, tokenB, tokenA, tokenB, true],
  [
    "runtime-only siblings",
    authoredConfig,
    authoredConfig,
    runtimeConfig,
    runtimeConfig,
    authoredConfig,
    false,
  ],
  [
    "matching secret source",
    secretRef,
    authConfig("old-token"),
    secretRef,
    authConfig("new-token"),
    secretRef,
    true,
  ],
] as const)(
  "compares shared auth with %s",
  (_name, sourceConfig, config, fallbackPrev, next, fallbackSource, expected) => {
    secretsMocks.activeSnapshot = { sourceConfig, config };
    expect(didActiveSharedGatewayAuthChange({ fallbackPrev, next, fallbackSource })).toBe(expected);
  },
);
