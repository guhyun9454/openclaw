import { expect, it, vi } from "vitest";
import reefChannelEntry from "../index.js";
import { reefPlugin } from "./channel.js";
import { autonomyBudget, parseReefRelayUrl, ReefChannelConfigSchema } from "./config-schema.js";

const guardConfig = { pinnedModel: "test-model", policyVersion: "v1", timeoutMs: 5_000 };
const oauth = {
  ...guardConfig,
  authMode: "oauth",
  authProfileId: "openai:work",
  provider: "openai",
};

it.each([
  [{ guard: { ...oauth, provider: "anthropic" } }, false],
  [{ guard: { ...oauth, authProfileId: "" } }, false],
  [{ guard: { ...oauth, authProfileId: "openai:   " } }, false],
  [{ guard: { ...oauth, authProfileId: "openai:team/work" } }, false],
  [{ guard: { ...oauth, authProfileId: "anthropic:work" } }, false],
  [{ guard: { ...oauth, apiKeyEnv: "OPENAI_API_KEY" } }, false],
  [{ friends: { peer: { legacy: true } } }, true],
  [{ allowFrom: [] }, false],
  [{ dmPolicy: "pairing" }, false],
  [{ relayUrl: "https://relay.example/tenant" }, false],
  [{ relayUrl: "https://relay.example\\tenant" }, false],
  [{ relayUrl: "https://relay.example/?tenant=a" }, false],
  [{ relayUrl: "https://user@relay.example/" }, false],
  [{ relayUrl: "ftp://relay.example/" }, false],
] as const)("validates Reef config %j", (input, accepted) => {
  expect(ReefChannelConfigSchema.safeParse(input).success).toBe(accepted);
});

it("normalizes an origin-wide relay endpoint", () => {
  expect(parseReefRelayUrl("https://relay.example/")).toBe("https://relay.example");
});

it("registers an authenticated owner-aware command", () => {
  const registerCommand = vi.fn();
  reefChannelEntry.register({ registrationMode: "tool-discovery", registerCommand } as never);
  expect(registerCommand).toHaveBeenCalledOnce();
  const command = registerCommand.mock.calls[0]![0];
  expect(command).toMatchObject({ name: "reef", requireAuth: true, exposeSenderIsOwner: true });
});

it("keeps read-only account and security inspection safe before runtime setup", async () => {
  const cfg = { channels: { reef: { handle: "owner" } } };
  const account = reefPlugin.config.resolveAccount(cfg, "default");

  expect(await reefPlugin.config.resolveAllowFromAsync?.({ cfg, accountId: "default" })).toEqual(
    [],
  );
  expect(await reefPlugin.config.describeAccountAsync?.(account, cfg)).toMatchObject({
    extra: { friendCount: 0 },
  });
  expect(
    await reefPlugin.security?.resolveDmPolicyAsync?.({ cfg, accountId: "default", account }),
  ).toMatchObject({ policy: "pairing", allowFrom: [] });
});
it.each([
  ["notify-only", true, 1, 86_400],
  ["bounded", false, 3, 86_400],
  ["extended", false, 12, 3_600],
] as const)(
  "maps %s to notify and bot-loop turn budget",
  (autonomy, notifyOnly, maxEventsPerWindow, windowSeconds) => {
    expect(autonomyBudget(autonomy)).toEqual({
      notifyOnly,
      botLoopProtection: {
        enabled: true,
        maxEventsPerWindow,
        windowSeconds,
        cooldownSeconds: 86_400,
      },
    });
  },
);
