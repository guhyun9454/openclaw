import childProcess from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { backupCase } from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";

const PRIVACY_MARKER = ".openclaw-private-update-capture";
const withFixture = backupCase({ prefix: "openclaw-backup-discovery-" });
const writeFiles = (directory: string, count: number, extension: string) =>
  Promise.all(
    Array.from({ length: count }, (_, index) =>
      fs.writeFile(path.join(directory, `generated-${index}.${extension}`), "export {};\n"),
    ),
  );
async function countProbes<T>(run: () => Promise<T>, file?: string) {
  let probes = 0;
  let fileProbes = 0;
  const original = fsSync.lstatSync.bind(fsSync);
  const spy = vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
    if (path.basename(String(target)) === PRIVACY_MARKER) {
      probes += 1;
    }
    if (String(target) === file) {
      fileProbes += 1;
    }
    return original(target, options);
  });
  try {
    const result = await run();
    return { probes, fileProbes, result };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabase();
});

describe.skipIf(process.platform === "win32")("backup SQLite discovery performance", () => {
  it.skipIf(process.getuid?.() === 0)(
    "skips unreadable excluded siblings of a protected config",
    withFixture(async (state) => {
      const configPath = state.statePath("tmp", "openclaw.json");
      const excludedPath = state.statePath("tmp", "cache.bin");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.copyFile(state.configPath, configPath);
      await fs.writeFile(excludedPath, "excluded cache");
      await fs.chmod(excludedPath, 0);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      try {
        await expect(fs.readFile(excludedPath)).rejects.toMatchObject({ code: "EACCES" });
        const archive = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
        });
        const entries = await listArchiveEntries(archive.archivePath);
        expect(entries.some((entry) => entry.endsWith("/tmp/openclaw.json"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/tmp/cache.bin"))).toBe(false);
      } finally {
        await fs.chmod(excludedPath, 0o600);
      }
    }),
  );

  it(
    "keeps privacy admission proportional to worktree directories while archiving dirty files",
    withFixture(async (state) => {
      openOpenClawStateDatabase({ env: state.env });
      closeOpenClawStateDatabase();

      const worktreeRelative = "worktrees/repository/active";
      const worktree = state.statePath(worktreeRelative);
      const sourceDirectories = Array.from({ length: 12 }, (_, index) =>
        path.join(worktree, "packages", `package-${index}`, "src"),
      );
      await Promise.all(
        sourceDirectories.map((directory) => fs.mkdir(directory, { recursive: true })),
      );

      const archive = (label: string) =>
        createBackupArchive({ output: state.path(`${label}.tar.gz`), includeWorkspace: false });
      const baseline = await countProbes(() => archive("baseline"));
      const durableFile = path.join(sourceDirectories[0]!, "uncommitted.ts");
      await Promise.all(sourceDirectories.map((directory) => writeFiles(directory, 40, "ts")));
      await fs.writeFile(durableFile, "export const keep = true;\n");

      const spawn = vi.spyOn(childProcess, "spawnSync");
      const populated = await countProbes(() => archive("populated"), durableFile);
      expect(populated.probes).toBeLessThanOrEqual(baseline.probes + 32);
      expect(populated.fileProbes).toBe(1);
      const headerProbes = spawn.mock.calls.filter(
        ([, args]) =>
          Array.isArray(args) && /[/\\]sqlite-header-probe\.worker\.[jt]s$/.test(args.at(-1) ?? ""),
      );
      // Global capture precedes the final, registry-backed inventory.
      expect(headerProbes).toHaveLength(2);
      const entries = await listArchiveEntries(populated.result.archivePath);
      const archivedDirtyFile = `/${worktreeRelative}/packages/package-0/src/uncommitted.ts`;
      expect(entries.some((entry) => entry.endsWith(archivedDirtyFile))).toBe(true);
    }),
  );
});
