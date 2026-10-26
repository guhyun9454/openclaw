import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { buildPluginApi } from "./api-builder.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

function createPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"] = {}) {
  return buildPluginApi({
    id: "late-call-fixture",
    name: "Late Call Fixture",
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: {} as PluginRuntime,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath: (input) => input,
    handlers,
  });
}

function captureRegisteredPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"]) {
  const api = createPluginApi(handlers);
  let captured: OpenClawPluginApi | undefined;
  runPluginRegisterSyncInRegistry(
    (pluginApi) => {
      captured = pluginApi;
    },
    api,
    createEmptyPluginRegistry(),
    "late-call-fixture",
  );
  return expectDefined(captured, "captured plugin api");
}

describe("plugin api lifecycle", () => {
  it("keeps inherited handlers, undefined defaults, and one captured CLI lookup", () => {
    const reads: string[] = [];
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    class InheritedHandlers {
      get registerCli() {
        reads.push("cli");
        return registerCli;
      }
      get registerTool() {
        reads.push("tool");
        return undefined;
      }
    }
    const api = createPluginApi(new InheritedHandlers());
    const registrar: Parameters<OpenClawPluginApi["registerCli"]>[0] = () => {};

    const toolFactory = vi.fn(() => null);
    expect(api.registerTool(toolFactory)).toBeUndefined();
    expect(toolFactory).not.toHaveBeenCalled();
    api.registerNodeCliFeature(registrar, { commands: ["camera"] });
    expect(registerCli).toHaveBeenCalledExactlyOnceWith(registrar, {
      commands: ["camera"],
      parentPath: ["nodes"],
    });
    expect(reads).toEqual(["cli", "tool"]);
  });

  it.each<[string, unknown, boolean]>([
    ["runContext.clearRunContext", undefined, true],
    ["agent.events.emitAgentEvent", { emitted: false, reason: "not wired" }, true],
    ["enqueueNextTurnInjection", { enqueued: false, id: "", sessionKey: "agent:main:main" }, true],
    [
      "session.workflow.enqueueNextTurnInjection",
      { enqueued: false, id: "", sessionKey: "agent:main:main" },
      true,
    ],
    ["session.workflow.steerActiveRun", { steered: false, reason: "not wired" }, true],
    ["runContext.getRunContext", undefined, true],
    ["session.workflow.sendSessionAttachment", { ok: false, error: "not wired" }, true],
    ["session.workflow.scheduleSessionTurn", undefined, true],
    ["runContext.setRunContext", false, true],
    ["session.workflow.unscheduleSessionTurnsByTag", { removed: 0, failed: 0 }, true],
    ["registerSessionSchedulerJob", undefined, false],
    ["registerTool", undefined, false],
    ["session.state.registerSessionExtension", undefined, false],
    ["session.controls.registerSessionAction", undefined, false],
    ["unknown", undefined, false],
    ["__proto__", undefined, false],
  ])(
    "keeps the unwired default and post-registration eligibility for %s",
    async (methodName, fallback, eligible) => {
      const input = { sessionKey: "agent:main:main", text: "guidance", namespace: "workflow" };
      const output = { forwarded: true };
      const handler = vi.fn(async () => output);
      const path = methodName.split(".");
      const invoke = (api: OpenClawPluginApi) => {
        const method = path.reduce<unknown>(
          (value, key) =>
            value && typeof value === "object" ? Reflect.get(value, key) : undefined,
          api,
        );
        return typeof method === "function" ? Reflect.apply(method, api, [input]) : undefined;
      };
      expect(await invoke(createPluginApi())).toStrictEqual(fallback);
      const api = captureRegisteredPluginApi({ [path.at(-1)!]: handler });
      expect(await invoke(api)).toBe(eligible ? output : undefined);
      expect(handler.mock.calls).toEqual(eligible ? [[input]] : []);
    },
  );
});
