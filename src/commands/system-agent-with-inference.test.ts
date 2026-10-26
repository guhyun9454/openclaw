import { beforeEach, expect, it, vi } from "vitest";
import { runSystemAgentWithInference } from "./system-agent-with-inference.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  execute: vi.fn(),
  onboard: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInference: mocks.verify,
}));
vi.mock("../system-agent/system-agent.js", () => ({
  runSystemAgent: mocks.execute,
}));
vi.mock("./onboard-guided.js", () => ({
  runGuidedOnboarding: mocks.onboard,
}));

vi.mock("../cli/one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: mocks.finish,
}));

const tty = { isTTY: true } as unknown as NodeJS.ReadableStream & NodeJS.WritableStream;
const pipe = { isTTY: false } as unknown as NodeJS.ReadableStream & NodeJS.WritableStream;
const verifiedInference = { execution: { modelLabel: "openai/gpt-5.5" } } as never;
const expiredAuth = { ok: false, status: "auth", error: "login expired" };
let runtime: ReturnType<typeof createTestRuntime>;
const run = (opts: Parameters<typeof runSystemAgentWithInference>[0]) =>
  runSystemAgentWithInference(opts, runtime);
const interactive = { input: tty, output: tty };

beforeEach(() => {
  vi.resetAllMocks();
  runtime = createTestRuntime();
  mocks.verify.mockResolvedValue({ ok: true, binding: verifiedInference });
  mocks.finish.mockReturnValue(false);
});

it("requests a clean process exit after successful noninteractive output", async () => {
  await run({ interactive: false });

  expect(mocks.finish).toHaveBeenCalledWith(runtime);
  expect(mocks.verify).toHaveBeenCalledWith({
    runtime,
    bindSession: true,
  });
  expect(mocks.execute).toHaveBeenCalledWith(
    expect.objectContaining({ verifiedInference }),
    runtime,
  );
  expect(mocks.verify).toHaveBeenCalledBefore(mocks.execute);
  expect(mocks.execute).toHaveBeenCalledBefore(mocks.finish);
});

it.each([
  [
    "execution",
    { message: "install plugin", yes: true },
    mocks.execute,
    "Plugin install spec is invalid.",
    false,
  ],
  ["verification", { json: true }, mocks.verify, "verification exploded", true],
  ["approval", { json: true, yes: true }, undefined, "OpenClaw --yes requires --message", false],
] as const)(
  "reports %s failure once before exiting",
  async (_name, opts, source, error, drained) => {
    source?.mockRejectedValue(new Error(error));
    mocks.finish.mockReturnValue(drained);
    await run(opts);
    const json = "json" in opts && opts.json;
    expect(json ? runtime.log : runtime.error).toHaveBeenCalledExactlyOnceWith(
      json ? expect.stringContaining('"error": "' + error) : error,
    );
    expect(json ? runtime.error : runtime.log).not.toHaveBeenCalled();
    if (source !== mocks.execute) {
      expect(mocks.execute).not.toHaveBeenCalled();
    }
    if (!source) {
      expect(mocks.verify).not.toHaveBeenCalled();
    }
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(runtime, 1);
    expect(runtime.exit.mock.calls).toEqual(drained ? [] : [[1]]);
  },
);

it("lets interactive OpenClaw execution errors propagate", async () => {
  mocks.execute.mockRejectedValue(new Error("interactive operation failed"));

  await expect(run(interactive)).rejects.toThrow("interactive operation failed");

  expect(runtime.error).not.toHaveBeenCalled();
  expect(mocks.finish).not.toHaveBeenCalled();
});

it("routes an interactive inference failure into guided setup", async () => {
  mocks.verify.mockResolvedValue(expiredAuth);

  await runSystemAgentWithInference(interactive, runtime, {
    workspace: "/tmp/work",
    acceptRisk: true,
  });

  expect(mocks.onboard).toHaveBeenCalledWith(
    { workspace: "/tmp/work", acceptRisk: true },
    runtime,
    { handoffMode: "chat" },
  );
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("rejects an impossible interactive request before probing inference", async () => {
  await run({ input: pipe, output: pipe });

  expect(runtime.error).toHaveBeenCalledWith(
    "OpenClaw needs an interactive TTY. Use --message for one command.",
  );
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expect(mocks.verify).not.toHaveBeenCalled();
});

it("offers onboarding guidance when inference is unavailable", async () => {
  mocks.verify.mockResolvedValue(expiredAuth);
  await run({ json: true });
  expect(runtime.log).toHaveBeenCalledWith(
    expect.stringContaining('"guidance": "Run `openclaw onboard`'),
  );
});
