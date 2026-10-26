import { describe, expect, it, vi } from "vitest";
import {
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "../gateway/subagent-completion-tool-handoff.js";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import { applyDelegationCapability, resolveDelegationCapability } from "./delegation-capability.js";
import { attachToolAllowlistIntersection } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

function createTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute: vi.fn(async () => ({ content: [], details: {} })),
  } as unknown as AnyAgentTool;
}

function resolveReport(overrides: Partial<Parameters<typeof resolveDelegationCapability>[0]> = {}) {
  return resolveDelegationCapability({
    fallbackActive: false,
    inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
    ...overrides,
  });
}

describe("delegation capability", () => {
  it.each([
    "current",
    "provenance only",
    "report only",
    "revoked",
    "wrong session",
    "wrong model",
    "missing lineage",
  ])("preserves only a verified requester continuation on fallback: %s", (state) => {
    const child = "agent:main:subagent:child";
    const parent = "agent:main:main";
    let current = true;
    const registration = {
      sourceSessionKey: child,
      targetSessionKey: parent,
      targetSessionId: "parent-id",
      idempotencyKey: "delegation-" + state,
      ...(state === "report only"
        ? {}
        : { settleBatch: { sourceSessionKeys: [child], isCurrent: () => current } }),
    };
    const sourceTool = state === "report only" ? "subagent_announce" : "subagent_settle";
    const handoff = consumeSubagentCompletionToolHandoff({
      ...registration,
      handoffId: registerSubagentCompletionToolHandoff(registration),
      sourceTool,
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    current = state !== "revoked";
    const lineage = {
      [child]: {
        spawnedBy: parent,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["sessions_send", "sessions_spawn"],
      },
    };
    expect(
      resolveDelegationCapability({
        fallbackActive: true,
        inputProvenance: { kind: "inter_session", sourceTool, sourceSessionKey: child },
        requesterContinuation: {
          config: {},
          sessionKey: parent,
          sessionId: state === "wrong session" ? "new-id" : "parent-id",
          modelProvider: "openai",
          modelId: state === "wrong model" ? "gpt-4.1" : "gpt-4.1-mini",
          trustedInternalHandoff: state === "provenance only" ? undefined : handoff,
          preparedSessionCapabilityStore: state === "missing lineage" ? {} : lineage,
        },
      }),
    ).toBe(state === "current" ? "host_only" : "report_only");
  });

  it.each([
    [{ fallbackActive: true }, "report_only"],
    [
      {
        fallbackActive: true,
        inputProvenance: { kind: "inter_session", sourceTool: "agent_harness_task" },
      },
      "report_only",
    ],
    [{}, "full"],
    [{ fallbackActive: true, inputProvenance: { kind: "external_user" } }, "full"],
    [{ disableTools: true }, "report_only"],
    [{ toolsAllow: [] }, "report_only"],
    [{ toolsAllow: ["message"] }, "report_only"],
    [{ toolsAllow: ["message", "*"] }, "full"],
    [{ toolsAllow: ["sessions_*"] }, "full"],
    [
      {
        toolsAllow: attachToolAllowlistIntersection(
          ["sessions_spawn", "message"],
          [["sessions_spawn", "message"], ["message"]],
        ),
      },
      "report_only",
    ],
  ] satisfies [Parameters<typeof resolveReport>[0], string][])(
    "resolves completion capability for %j",
    (params, expected) => {
      expect(resolveReport(params)).toBe(expected);
    },
  );

  it("removes delegation tools but retains ordinary reporting tools", () => {
    const tools = [
      "sessions_spawn",
      "sessions_send",
      "openclaw",
      "llm-task",
      "codex_session_send",
      "message",
      "gateway",
      "sessions_history",
    ].map(createTool);

    expect(applyDelegationCapability(tools, "report_only").map((tool) => tool.name)).toEqual([
      "message",
      "gateway",
      "sessions_history",
    ]);
    expect(applyDelegationCapability(tools, "full")).toBe(tools);
    expect(applyDelegationCapability(tools, "host_only")).toBe(tools);
  });

  it("retains plugin ownership and reporting actions while rejecting new background work", async () => {
    const tools = [createTool("cron"), createTool("image_generate")];
    setPluginToolMeta(tools[0]!, { pluginId: "scheduler" } as never);
    const [cron, image] = applyDelegationCapability(tools, "report_only");
    expect(cron).not.toBe(tools[0]);
    expect(getPluginToolMeta(cron!)).toEqual({ pluginId: "scheduler" });

    const result = { content: [], details: {} };
    const denied = "New delegation is unavailable";
    await expect(cron?.execute("cron-remove", { action: "remove" })).resolves.toEqual(result);
    await expect(image?.execute("image-status", { action: "status" })).resolves.toEqual(result);
    await expect(image?.execute("image-generate", {})).rejects.toThrow(denied);
    expect(tools[0]?.execute).toHaveBeenCalledTimes(1);
    expect(tools[1]?.execute).toHaveBeenCalledTimes(1);
  });
});
