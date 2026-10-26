import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  runRuntimeToolFixtureWithDeps,
  runtimeToolFixtureDeps,
  type RuntimeToolFixtureDeps,
  transcriptToolCall,
  transcriptToolResult,
  writeQaSessionTranscript,
} from "../test/runtime-tool-fixture-helpers.js";
import {
  getQaNativeWorkspaceBehavior,
  type QaNativeWorkspaceBehavior,
} from "./native-workspace-behavior.js";
import { readQaScenarioFile } from "./scenario-catalog.js";
import { createSession } from "./suite-runtime-agent-session.js";

function nativeReceipt(behavior: QaNativeWorkspaceBehavior, phase: "happy" | "failure") {
  const args = phase === "happy" ? behavior.happyArgs : behavior.failureArgs;
  const target = phase === "happy" ? behavior.happyMutation : behavior.failureSentinel;
  const input =
    behavior.nativeToolName === "bash"
      ? { command: `/bin/zsh -lc ${JSON.stringify(args.cmd)}` }
      : { changes: [{ path: target?.path, kind: { type: "update" } }] };
  return [
    transcriptToolCall(behavior.nativeToolName, phase, input),
    transcriptToolResult(
      behavior.nativeToolName,
      phase,
      phase === "happy"
        ? (behavior.happyOutputMarker ?? "native workspace change completed")
        : (behavior.failureOutputMarker ?? "path escapes workspace root"),
      phase === "failure" ? true : undefined,
    ),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests({ closeDatabase: false });
});
afterAll(cleanupRuntimeToolFixtureTempRoots);

describe("Codex-native workspace runtime tool fixtures", () => {
  it.each(["edit", "fs-write"] as const)(
    "requires correlated native receipts and observable %s outcomes",
    async (behaviorId) => {
      const env = await makeEnv();
      env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
      const behavior = getQaNativeWorkspaceBehavior(behaviorId);
      const mutation = expectDefined(behavior.happyMutation, "native workspace mutation");
      const sentinel = expectDefined(behavior.failureSentinel, "outside-workspace sentinel");
      const runtimeToolName = behaviorId === "edit" ? "edit" : "write";
      const readWorkspaceFile = (file: string) =>
        fs.readFile(path.resolve(env.gateway.workspaceDir, file), "utf8");
      const writeWorkspaceFile = (file: { path: string; contents: string }) =>
        fs.writeFile(path.resolve(env.gateway.workspaceDir, file.path), file.contents, "utf8");
      if (behaviorId === "fs-write") {
        await writeWorkspaceFile(mutation);
      }

      let generatedSessionIndex = 0;
      const promptEvidence: [string | undefined, boolean | undefined][] = [];
      const details = await runRuntimeToolFixtureWithDeps(
        env,
        {
          toolName: runtimeToolName,
          nativeWorkspaceBehavior: behaviorId,
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          ...runtimeToolFixtureDeps({
            runAgentPrompt: async (_env, params) => {
              promptEvidence.push([
                params.transcriptToolName,
                params.requireSuccessfulTranscriptToolResult,
              ]);
              const phase = params.sessionKey.endsWith(":happy") ? "happy" : "failure";
              await writeQaSessionTranscript(
                env,
                params.sessionKey,
                nativeReceipt(behavior, phase),
              );
              if (behaviorId === "fs-write" && phase === "failure") {
                await expect(readWorkspaceFile(sentinel.path)).resolves.toBe(sentinel.contents);
              }
              if (phase === "happy") {
                if (behaviorId === "fs-write") {
                  await expect(readWorkspaceFile(mutation.path)).rejects.toThrow();
                }
                await writeWorkspaceFile(mutation);
              }
              return {};
            },
          }),
          createSession: async (_env, label, key) => {
            expect(key).toBeUndefined();
            const phase = label.endsWith(" happy") ? "happy" : "failure";
            generatedSessionIndex += 1;
            return `agent:qa:native-workspace:${runtimeToolName}:${generatedSessionIndex}:${phase}`;
          },
        },
      );

      expect(promptEvidence).toEqual([
        [behavior.nativeToolName, true],
        [behavior.nativeToolName, undefined],
      ]);
      expect(details).toContain(`codex-native ${behaviorId} behavior passed`);
      await expect(readWorkspaceFile(mutation.path)).resolves.toBe(mutation.contents);
      await expect(readWorkspaceFile(sentinel.path)).rejects.toThrow();
    },
  );
  it("uses stable behavior labels and fresh session keys for sequential native fixtures", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    let sessionIndex = 0;
    const sessions: { key?: string; label: string; created: string }[] = [];
    env.gateway.call = vi.fn(async (method, params) => {
      expect(method).toBe("sessions.create");
      const { label, key } = params as { label: string; key?: string };
      const phase = label.endsWith(" happy") ? "happy" : "failure";
      sessionIndex += 1;
      const sessionKey = `agent:qa:native-workspace:sequence:${sessionIndex}:${phase}`;
      sessions.push({ key, label, created: sessionKey });
      return { key: sessionKey };
    });
    const runAgentPrompt: RuntimeToolFixtureDeps["runAgentPrompt"] = async (_env, params) => {
      const behaviorId = expectDefined(
        (["bash", "exec", "grep"] as const).find((id) =>
          params.message.includes(`native-workspace-behavior=${id}.`),
        ),
        "native workspace behavior missing from prompt",
      );
      const behavior = getQaNativeWorkspaceBehavior(behaviorId);
      const phase = params.sessionKey.endsWith(":happy") ? "happy" : "failure";
      await writeQaSessionTranscript(env, params.sessionKey, nativeReceipt(behavior, phase));
      return {};
    };
    const deps = { ...runtimeToolFixtureDeps({ runAgentPrompt }), createSession };

    for (const behaviorId of ["bash", "exec", "grep", "bash"] as const) {
      const scenario = readQaScenarioFile(
        path.resolve(import.meta.dirname, `../../../qa/scenarios/runtime/tools/${behaviorId}.yaml`),
      );
      await expect(
        runRuntimeToolFixtureWithDeps(env, scenario.execution.config!, deps),
      ).resolves.toContain(`codex-native ${behaviorId} behavior passed`);
    }

    expect(sessions.map(({ key }) => key)).toEqual(Array(8).fill(undefined));
    expect(new Set(sessions.map(({ created }) => created)).size).toBe(8);
    expect(sessions.map(({ label }) => label)).toEqual(
      ["bash", "exec", "grep", "bash"].flatMap((id) =>
        ["happy", "failure"].map((phase) => `Runtime tool fixture: ${id} ${phase}`),
      ),
    );
  });
});
