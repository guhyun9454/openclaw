import { expect, onTestFinished, test } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";

const config: OpenClawConfig = {
  agents: { defaults: { model: { primary: "openai/worker-model" } }, entries: { main: {} } },
  cloudWorkers: {
    requiredProfile: "dedicated",
    profiles: {
      dedicated: { provider: "device", settings: { device: "paired", inference: "worker" } },
    },
  },
};
const models = ["worker-model", "other-model"].map((id) => ({
  id,
  name: id,
  provider: "openai",
  available: false,
  unavailableReason: "missing-auth",
}));
type Harness = ReturnType<typeof createChatMetadataHarness>;
const mainScope = { agentId: "main", sessionKey: "agent:main:main" };
async function readyMetadata(cfg = config, catalog = models) {
  const harness = createChatMetadataHarness(cfg);
  onTestFinished(() => harness.runtime.stop());
  harness.buildProjection.mockResolvedValue({ modelCatalog: catalog, models: catalog });
  await harness.runtime.refresh();
  return harness;
}

test("publishes cold pinned startup commands without retaining worker policy across refresh", async () => {
  const cfg = structuredClone(config);
  const harness = createChatMetadataHarness(cfg);
  onTestFinished(() => harness.runtime.stop());
  const scope = {
    ...mainScope,
    sessionEntry: {
      authProfileOverride: "openai:pinned",
      authProfileOverrideSource: "user" as const,
    },
  };
  await harness.refresh();
  const published = (await harness.startup(scope))?.metadata;
  expect(published).toBeDefined();
  expect(published?.requiredWorkerInferenceProfileId).toBe("dedicated");
  expect(published?.commands).toEqual(expect.any(Array));
  expect(harness.buildProjection).not.toHaveBeenCalled();
  delete cfg.cloudWorkers!.requiredProfile;
  const refreshed = await harness.read({ includeModels: false, ifRevision: published?.revision });
  expect(refreshed.commands).toEqual(published?.commands);
  expect(refreshed.requiredWorkerInferenceProfileId).toBeUndefined();
});

test("required worker chat metadata admits cold main and bookmarked sessions without Gateway auth", async () => {
  const harness = await readyMetadata();
  for (const scope of [
    { agentId: "main", sessionKey: "agent:main:main" },
    { agentId: "main", sessionKey: "agent:main:bookmark", sessionEntry: { sessionId: "saved" } },
  ]) {
    const metadata = await harness.runtime.read(scope);
    expect(metadata.models?.[0]).not.toHaveProperty("unavailableReason");
    expect(metadata.models?.[0]).not.toHaveProperty("available");
    expect(metadata.models?.[1]).toEqual(models[1]);
    expect((await harness.runtime.readStartup(scope))?.metadata).toMatchObject({
      requiredWorkerInferenceProfileId: "dedicated",
    });
  }
  expect((await harness.runtime.read({ agentId: "main" })).models).toEqual(models);
  expect(models[0]).toHaveProperty("unavailableReason", "missing-auth");
});

type AvailabilityCase = {
  worker?: OpenClawConfig["cloudWorkers"];
  sessionEntry?: Parameters<Harness["runtime"]["read"]>[0]["sessionEntry"];
  catalog?: typeof models;
};
const profile = config.cloudWorkers!.profiles!.dedicated!;
const workerProfile = (overrides: Partial<typeof profile>) => ({
  profiles: { dedicated: { ...profile, ...overrides } },
});
const availabilityCases: Record<string, AvailabilityCase> = {
  "missing profile": { worker: { profiles: {} } },
  "Gateway inference": {
    worker: workerProfile({ settings: { ...profile.settings, inference: "gateway" } }),
  },
  "invalid provider": { worker: workerProfile({ provider: "external" }) },
  "missing device": { worker: workerProfile({ settings: { ...profile.settings, device: "" } }) },
  "optional worker": { worker: { requiredProfile: undefined } },
  "non-auth failure": {
    catalog: models.map((model) => ({ ...model, unavailableReason: "cooldown" })),
  },
  "explicit auto": { sessionEntry: { agentRuntimeOverride: "auto" } },
  "explicit default": { sessionEntry: { agentRuntimeOverride: "default" } },
  "explicit openclaw": { sessionEntry: { agentRuntimeOverride: "openclaw" } },
  "explicit native": { sessionEntry: { agentRuntimeOverride: "codex" } },
  "locked native harness": {
    sessionEntry: {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      agentRuntimeOverride: "openclaw",
    },
  },
};
test.each(Object.entries(availabilityCases))(
  "retains Gateway availability for %s",
  async (_name, { worker, sessionEntry, catalog = models }) => {
    const harness = await readyMetadata(
      { ...config, cloudWorkers: { ...config.cloudWorkers, ...worker } },
      catalog,
    );
    expect((await harness.runtime.read({ ...mainScope, sessionEntry })).models).toEqual(catalog);
  },
);
