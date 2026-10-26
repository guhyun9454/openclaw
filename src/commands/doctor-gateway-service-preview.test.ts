import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  makeDoctorIo,
  makeDoctorPrompts,
  pinSnapshotMock,
} from "./doctor-gateway-runtime.test-utils.js";
import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";
import { fsMocks, mocks } from "./doctor-gateway-services.native.test-support.js";

await vi.hoisted(() => import("./doctor-gateway-services.native.test-support.js"));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repairCommand = "`openclaw --profile preview-proof gateway install --force`";

beforeEach(() => {
  vi.clearAllMocks();
  pinSnapshotMock.mockReturnValue({ revision: "empty", stored: false });
  fsMocks.realpath.mockImplementation(async (value: string) => value);
  mocks.readRuntime.mockResolvedValue({ status: "unknown" });
  mocks.resolveNodeRuntimeInfo.mockResolvedValue({ status: "supported" });
  mocks.resolveGatewayAuthTokenForService.mockResolvedValue({});
  mocks.needsNodeRuntimeMigration.mockReturnValue(true);
  mocks.resolveSystemNodeInfo.mockResolvedValue(null);
});

it.each([
  { supported: false, approved: false },
  { supported: false, approved: true },
  { supported: true, approved: false },
])(
  "previews runtime repair before consent (supported=$supported, approved=$approved)",
  async ({ supported, approved }) => {
    let entrypoint = "/synthetic/openclaw/dist/index.js";
    if (!supported) {
      const root = tempDirs.make("openclaw-doctor-preview-");
      for (const directory of [".git", "src", "extensions", "dist"]) {
        await fs.mkdir(path.join(root, directory));
      }
      await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');
      entrypoint = path.join(root, "dist", "index.js");
      await fs.writeFile(entrypoint, "export {};\n");
    }
    const node = "/home/test/.nvm/versions/node/v24.16.0/bin/node";
    const replacement = supported ? "/usr/bin/node" : node;
    const command = {
      programArguments: [node, entrypoint, "gateway"],
      environment: supported ? {} : { PATH: "/old/bin" },
    };
    mocks.readCommand.mockResolvedValue(command);
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ runtimePath }) => ({
      programArguments: [supported ? (runtimePath ?? node) : node, entrypoint, "gateway"],
      environment: supported ? {} : { PATH: "/usr/bin:/bin" },
    }));
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: supported
            ? "runtime"
            : approved
              ? "gateway-runtime-node"
              : "gateway-runtime-node-version-manager",
          message: supported
            ? "runtime migration"
            : approved
              ? "unsupported Node capability"
              : "version-managed Node",
          level: "recommended",
        },
      ],
      definitionDrift: supported
        ? []
        : [
            {
              kind: "outdated",
              key: "ExitTimeOut",
              current: 20,
              expected: 330,
              message: "old shutdown budget",
            },
          ],
    });
    if (supported) {
      mocks.resolveSystemNodeInfo.mockResolvedValue({
        path: replacement,
        status: "supported",
        version: "24.16.0",
      });
    }
    const prompter = makeDoctorPrompts();
    prompter.confirmRuntimeRepair.mockImplementation(async ({ message }) => {
      const preview = mocks.note.mock.calls.find(
        ([, title]) => title === "Gateway service repair preview",
      )?.[0];
      expect(preview).toContain(`Runtime: ${node} -> ${replacement}`);
      expect(preview).toContain(
        supported ? "PATH: not set -> not set" : "PATH: /old/bin -> /usr/bin:/bin",
      );
      if (supported) {
        expect(preview).not.toContain("No supported system Node");
      } else {
        for (const text of [
          `Entrypoint: ${entrypoint} -> ${entrypoint}`,
          "Shutdown budget (ExitTimeOut): 20 -> 330",
          "No supported system Node is available",
          "retains a source-checkout entrypoint",
          repairCommand,
        ]) {
          expect(preview).toContain(text);
        }
        expect(message).not.toContain("recommended defaults");
      }
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining(repairCommand),
        "Gateway service config",
      );
      return approved;
    });
    const onFinding = vi.fn();
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_PROFILE: "preview-proof",
        OPENCLAW_CONTAINER_HINT: undefined,
      },
      () =>
        maybeRepairGatewayServiceConfig({ gateway: {} }, "local", makeDoctorIo(), prompter, {
          writeConfig: mocks.writeConfig,
          onFinding,
        }),
    );
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledTimes(Number(approved));
    if (approved) {
      expect(onFinding).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "error",
          category: "fix-now",
          fixHint: expect.stringContaining("Install system Node"),
        }),
      );
      expect(onFinding).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "recommended",
          fixHint: expect.stringContaining("gateway install --force"),
        }),
      );
      expect(mocks.install).toHaveBeenCalledWith(
        expect.objectContaining({ programArguments: command.programArguments }),
      );
    } else {
      expect(onFinding).not.toHaveBeenCalled();
      expect(
        mocks.note.mock.calls.some(
          ([, title]) => title === "Gateway service findings still unresolved",
        ),
      ).toBe(false);
    }
  },
);
