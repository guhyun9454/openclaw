import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { getModelProviderLocalServiceReconciler } from "./provider-local-service-reconcile.js";
import {
  attachModelProviderLocalService,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

type Auth = { mode: string; authFlow?: string };
const { fetchWithSsrFGuard, prepare, providerStream, reconcile } = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  prepare: vi.fn(async (_auth?: Auth) => undefined),
  providerStream: vi.fn(),
  reconcile: vi.fn(async () => undefined),
}));

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode: vi.fn((params) => params),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: vi.fn(() => providerStream),
}));

vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderRuntimePluginHandle: (
      params: Parameters<typeof actual.resolveProviderRuntimePluginHandle>[0],
    ) => ({
      provider: params.provider,
      modelId: params.modelId,
      plugin: {
        reconcileLocalService: reconcile,
        wrapStreamFn:
          ({ streamFn, auth }: { streamFn: typeof providerStream; auth?: Auth }) =>
          async (...args: Parameters<typeof providerStream>) => {
            await prepare(auth);
            return streamFn(...args);
          },
      },
    }),
  };
});

function lifecycleModel(api = "test-lifecycle-provider") {
  const registry = createApiRegistry();
  const model = bindModelLlmRuntime(
    makeProviderModelFixture({
      api,
      provider: api === "ollama" ? api : "test-provider",
      id: "test-model",
      baseUrl: "http://127.0.0.1:19432/v1",
    }),
    createLlmRuntime(registry),
  );
  return { model, apiRegistry: registry };
}

const guardedResponse = () => ({
  response: new Response("ok"),
  finalUrl: "http://127.0.0.1:19432/v1/responses",
  release: vi.fn(async () => undefined),
});

describe("provider stream lifecycle registration", () => {
  beforeEach(() => {
    fetchWithSsrFGuard.mockReset().mockResolvedValue(guardedResponse());
    prepare.mockClear();
    providerStream.mockReset();
    vi.mocked(resolveProviderStreamFn).mockClear();
    reconcile.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await stopManagedProviderLocalServices();
  });

  it("registers provider streams with the resolved runtime lifecycle handle", async () => {
    providerStream.mockReturnValue(createAssistantMessageEventStream());
    const { model, apiRegistry } = lifecycleModel();
    const auth = { mode: "oauth", authFlow: "test-subscription" };
    const streamFn = registerProviderStreamForModel({ model, wrapProviderStream: true, auth });
    expect(apiRegistry.getApiProvider(model.api)).toBeDefined();
    await streamFn?.(model, {} as never, {});
    expect(getModelProviderLocalServiceReconciler(providerStream.mock.calls[0]![0])).toBe(
      reconcile,
    );
    expect(prepare).toHaveBeenCalledExactlyOnceWith(auth);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      providerStream.mock.invocationCallOrder[0]!,
    );
  });

  it.each([undefined, new Error("preset reload failed")])(
    "reconciles before direct-compaction provider requests (error=%s)",
    async (reconcileError) => {
      const events: string[] = [];
      reconcile.mockImplementation(async () => {
        events.push("reload");
        if (reconcileError) {
          throw reconcileError;
        }
      });
      fetchWithSsrFGuard.mockImplementation(async () => {
        events.push("provider-request");
        return guardedResponse();
      });
      providerStream.mockImplementation(async (requestModel) => {
        const response = await buildGuardedModelFetch(requestModel)(
          "http://127.0.0.1:19432/v1/responses",
          { method: "POST", body: "{}" },
        );
        await response.text();
        return createAssistantMessageEventStream();
      });
      const { model: localModel, apiRegistry } = lifecycleModel("ollama");
      const model = attachModelProviderLocalService(localModel, {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        healthUrl: "http://127.0.0.1:19432/health",
      });
      expect(apiRegistry.getApiProvider("ollama")).toBeUndefined();
      const streamFn = registerProviderStreamForModel({
        model,
        agentDir: "/tmp/test-agent",
        workspaceDir: "/tmp/test-workspace",
        apiRegistry,
      });

      expect(vi.mocked(resolveProviderStreamFn).mock.calls[0]?.[0].context).toMatchObject({
        agentDir: "/tmp/test-agent",
        workspaceDir: "/tmp/test-workspace",
        provider: "ollama",
        modelId: "test-model",
        model: { api: "ollama", provider: "ollama", id: "test-model" },
      });
      expect(apiRegistry.getApiProvider("ollama")).toBeDefined();

      if (reconcileError) {
        await expect(streamFn?.(model, {} as never, {})).rejects.toThrow(reconcileError.message);
      } else {
        await streamFn?.(model, {} as never, {});
      }
      expect(events).toEqual(reconcileError ? ["reload"] : ["reload", "provider-request"]);
    },
  );
});
