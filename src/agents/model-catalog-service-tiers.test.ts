import { expectDefined } from "@openclaw/normalization-core";
import { assert, expect, it } from "vitest";
import { projectModelServiceTiers } from "../gateway/server-methods/models-list-public-projection.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { evaluate, platformRoute } from "./model-auth-availability.test-support.js";
import { providerConfig, snapshot as makeSnapshot } from "./model-catalog-fixtures.test-support.js";
import { createPreparedAccountCatalogAccess } from "./prepared-model-runtime.catalog-auth.js";

const entry = { provider: "fixture", id: "opaque-model" };
const route = {
  api: "openai-responses",
  baseUrl: "https://fixture.example/v1",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const;
const capability = {
  modelId: entry.id,
  runtimeId: "fixture-native",
  api: route.api,
  baseUrl: route.baseUrl,
  serviceTiers: ["ultrafast"],
};
const outcome: ProviderCatalogOutcome = {
  provider: entry.provider,
  profileId: "fixture:account-a",
  status: "ready",
  modelServiceTiers: [capability],
};
const profile = (profileId: string) =>
  ({ source: "profile", profileId, identityKey: `profile:${profileId}` }) as const;
const evaluation: ModelAuthAvailabilityEvaluation = {
  availability: true,
  routeResolution: null,
  selectedRoute: route,
  selectedProfileId: outcome.profileId,
  selectedCredential: { ...profile("fixture:account-a"), requirement: "subscription" },
};
const snapshot = (providerOutcomes: ProviderCatalogOutcome[] = [outcome]) =>
  makeSnapshot([], { providerOutcomes });
function resolve(overrides: Partial<Parameters<typeof projectModelServiceTiers>[0]> = {}) {
  return projectModelServiceTiers({
    config: {},
    entry,
    evaluation,
    runtimeId: capability.runtimeId,
    snapshot: snapshot(),
    isCurrent: () => true,
    ...overrides,
  });
}
it.each(["literal", "ref"] as const)(
  "evicts %s binding downgrades on record and fences stale observers",
  (kind) => {
    const provider = {
      ...platformRoute,
      apiKey:
        kind === "ref"
          ? { source: "env" as const, provider: "default", id: "FIXTURE_KEY_A" }
          : "synthetic-key-a",
      models: [],
    };
    const cfg = providerConfig("openai", provider);
    const env = { FIXTURE_KEY_A: "synthetic-key-a", FIXTURE_KEY_B: "synthetic-key-b" };
    const accountCatalog = createPreparedAccountCatalogAccess(() => true, undefined, cfg);
    const selected = () => evaluate({ cfg, env });
    const credential = expectDefined(selected().selectedCredential, "direct credential");
    assert(credential.source === "direct");
    const observation = {
      modelId: "synthetic-api-model",
      runtimeId: "openclaw",
      ...platformRoute,
      requestedTier: "ultrafast",
      responseTier: "priority",
    };
    const record = accountCatalog.prepareServiceTierObserver({ selectedCredential: credential });
    const read = () =>
      accountCatalog.readServiceTierObservations({
        ...observation,
        identityKey: credential.identityKey,
      });
    expect(record(observation)).toBe(true);
    const republished = evaluate({ cfg: { ...cfg, gateway: { port: 19001 } }, env });
    expect(republished.selectedCredential?.source).toBe("direct");
    accountCatalog.reconcileAuth({ version: 1, profiles: {} }, () => true);
    const originalBinding = structuredClone(provider.apiKey);
    if (typeof provider.apiKey === "string") {
      provider.apiKey = "synthetic-key-b";
    } else {
      provider.apiKey.id = "FIXTURE_KEY_B";
    }
    const replacementBinding = provider.apiKey;
    expect(record(observation)).toBe(false);
    // Restoring the old binding must not revive an evicted observer.
    provider.apiKey = originalBinding;
    expect(record(observation)).toBe(false);
    provider.apiKey = replacementBinding;
    expect(read()).toEqual([]);
    expect(record(observation)).toBe(false);
    const next = selected();
    expect(next.selectedCredential).toEqual(credential);
    expect(credential.identityKey).toBe("direct:openai");
    const replacement = accountCatalog.prepareServiceTierObserver({
      selectedCredential: expectDefined(next.selectedCredential, "replacement credential"),
    });
    expect(replacement(observation)).toBe(true);
  },
);
it("projects only the selected account/model/runtime/route and clears unknown observations", () => {
  const withEvaluation = (extra: Partial<ModelAuthAvailabilityEvaluation>) => ({
    evaluation: { ...evaluation, ...extra },
  });
  expect(resolve()).toEqual(["ultrafast"]);
  for (const overrides of [
    { runtimeId: "other-runtime" },
    { entry: { ...entry, id: "another-model" } },
    withEvaluation({
      selectedProfileId: "fixture:account-b",
      selectedCredential: profile("fixture:account-b"),
    }),
    withEvaluation({ selectedProfileId: undefined, selectedCredential: undefined }),
    withEvaluation({ selectedRoute: undefined }),
    withEvaluation({ availability: undefined }),
    withEvaluation({
      selectedRoute: { ...route, baseUrl: "https://other.example/v1" },
    }),
    { isCurrent: () => false },
    { snapshot: snapshot([{ ...outcome, status: "auth-rejected" }]) },
    { snapshot: snapshot([{ ...outcome, status: "unavailable" }]) },
    { snapshot: { ...snapshot(), refreshFailed: true } },
  ]) {
    expect(resolve(overrides)).toBeUndefined();
  }
});
