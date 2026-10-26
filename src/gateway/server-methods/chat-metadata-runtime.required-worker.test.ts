import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test } from "vitest";
import type { ChatMetadataResponse } from "../../../ui/src/lib/chat/chat-metadata-cache.ts";
import {
  beginChatMetadataPublication,
  revalidateChatMetadata,
} from "../../../ui/src/lib/chat/chat-metadata-store.ts";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.ts";
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
async function withMetadata(
  cfg: OpenClawConfig,
  run: (harness: Harness) => Promise<void>,
  catalog = models,
) {
  const harness = createChatMetadataHarness(cfg);
  harness.buildProjection.mockResolvedValue({ modelCatalog: catalog, models: catalog });
  try {
    await harness.runtime.refresh();
    await run(harness);
  } finally {
    await harness.runtime.stop();
  }
}

async function expectModels(harness: Harness, expected = models) {
  expect((await harness.runtime.read(mainScope)).models).toEqual(expected);
}

test("publishes cold pinned startup commands without retaining worker policy across refresh", async () => {
  const cfg = structuredClone(config);
  const harness = createChatMetadataHarness(cfg);
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionEntry: {
      authProfileOverride: "openai:pinned",
      authProfileOverrideSource: "user" as const,
    },
  };
  const client = createTestGatewayClient(async (method, params) => {
    if (method === "chat.startup") {
      return (await harness.startup(scope))?.metadata;
    }
    expect(method).toBe("chat.metadata");
    const ifRevision = asOptionalRecord(params)?.ifRevision;
    return harness.read({
      includeModels: false,
      ifRevision: typeof ifRevision === "string" ? ifRevision : undefined,
    });
  });
  try {
    await harness.refresh();
    const startup = await client.request<ChatMetadataResponse>("chat.startup", scope);
    const published = beginChatMetadataPublication(client, scope).publish(startup);
    expect(published.requiredWorkerInferenceProfileId).toBe("dedicated");
    expect(published.commands).toEqual(expect.any(Array));
    expect(harness.buildProjection).not.toHaveBeenCalled();
    delete cfg.cloudWorkers!.requiredProfile;
    const refreshed = await revalidateChatMetadata(client, scope);
    expect(refreshed.commands).toEqual(published.commands);
    expect(refreshed.requiredWorkerInferenceProfileId).toBeUndefined();
  } finally {
    await harness.runtime.stop();
  }
});

test("required worker chat metadata admits cold main and bookmarked sessions without Gateway auth", async () => {
  await withMetadata(config, async (harness) => {
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
    expect(
      (
        await harness.runtime.read({
          agentId: "main",
          sessionKey: "agent:main:pinned",
          sessionEntry: { agentRuntimeOverride: "codex" },
        })
      ).models,
    ).toEqual(models);
    expect(models[0]).toHaveProperty("unavailableReason", "missing-auth");
  });
});

test.each(["missing", "gateway", "invalid-provider", "no-device", "optional"])(
  "keeps Gateway credentials when required worker intent is not usable (%s)",
  async (kind) => {
    const cfg = structuredClone(config);
    if (kind === "missing") {
      cfg.cloudWorkers!.profiles = {};
    }
    if (kind === "gateway") {
      cfg.cloudWorkers!.profiles!.dedicated!.settings!.inference = "gateway";
    }
    if (kind === "invalid-provider") {
      cfg.cloudWorkers!.profiles!.dedicated!.provider = "external";
    }
    if (kind === "no-device") {
      cfg.cloudWorkers!.profiles!.dedicated!.settings!.device = "";
    }
    if (kind === "optional") {
      delete cfg.cloudWorkers!.requiredProfile;
    }
    await withMetadata(cfg, (harness) => expectModels(harness));
  },
);

test("scopes worker metadata to the saved selection and preserves non-auth availability", async () => {
  const cooldown = models.map((model) => ({ ...model, unavailableReason: "cooldown" }));
  await withMetadata(config, (harness) => expectModels(harness, cooldown), cooldown);
});

test.each([
  { agentRuntimeOverride: "auto" },
  { agentRuntimeOverride: "default" },
  { agentRuntimeOverride: "openclaw" },
  { agentHarnessId: "codex", modelSelectionLocked: true, agentRuntimeOverride: "openclaw" },
])("retains upstream availability for explicit runtime selection %j", async (sessionEntry) => {
  await withMetadata(config, async (harness) => {
    const result = await harness.runtime.read({
      agentId: "main",
      sessionKey: "agent:main:saved",
      sessionEntry,
    });
    // Required placement is intent, not a grant for explicit runtime/account choices.
    // Preserve the clients-stack overlay's explicit-selection checks.
    expect(result.models).toEqual(models);
  });
});
