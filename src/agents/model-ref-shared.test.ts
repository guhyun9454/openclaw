import { afterEach, beforeEach, expect, it } from "vitest";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { normalizeModelRef } from "./model-ref-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

function resetRuntime() {
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
}
beforeEach(resetRuntime);
afterEach(resetRuntime);

const normalize = () =>
  normalizeProviderModelIdWithRuntime({
    provider: "fixture",
    context: { provider: "fixture", modelId: "model" },
  });
function createGeneration() {
  const pluginRegistry = createEmptyPluginRegistry();
  for (const id of ["foreign", "fixture"]) {
    pluginRegistry.providers.push({
      pluginId: `${id}-owner`,
      source: `${id}-owner.ts`,
      provider: {
        id,
        label: id,
        auth: [],
        hookAliases: [id === "foreign" ? "fixture" : "fixture-alias"],
        normalizeModelId(this: ProviderPlugin, { modelId }) {
          return `${this.pluginId}-${modelId}`;
        },
      },
    });
  }
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: ["foreign", "fixture"].map((id) => ({ id: `${id}-owner`, providers: [id] })),
  });
  return { metadataSnapshot, pluginRegistry };
}

it("keeps an empty generation authoritative over ambient request hooks", () => {
  const generation = createGeneration();
  expect(
    withPluginRuntimeRegistryScope(generation.pluginRegistry, () =>
      withPluginRuntimeGenerationScope(
        { ...generation, pluginRegistry: createEmptyPluginRegistry() },
        normalize,
      ),
    ),
  ).toBeUndefined();
});

it("does not borrow an active provider on a request registry miss", () => {
  const generation = createGeneration();
  setActivePluginRegistry(generation.pluginRegistry, "another-gateway");
  expect(normalize()).toBe("fixture-owner-model");
  expect(withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), normalize)).toBeUndefined();
});

it("applies manifest normalization once without an executable hook", () => {
  const normalizeManifest = () => normalizeModelRef("fixture", "compat/compat/model");
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "fixture",
        providers: ["fixture"],
        modelIdNormalization: { providers: { fixture: { stripPrefixes: ["compat/"] } } },
      },
    ],
  });
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "fixture",
    provider: { id: "fixture", label: "Fixture", auth: [] },
  });
  const withMetadata = <T>(run: () => T) =>
    withPluginMetadataSnapshotScope(metadataSnapshot, run, { trustConfigIdentity: true });
  expect([
    withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      normalizeManifest,
    ),
    withMetadata(() => withPluginRuntimeRegistryScope(registry, normalizeManifest)),
    withMetadata(normalizeManifest),
  ]).toEqual(Array.from({ length: 3 }, () => ({ provider: "fixture", model: "compat/model" })));
});
