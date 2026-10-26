import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.js";
import { installGatewayDatabaseEngine } from "../../gateway/server-database-engine.js";
import { getDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { readBackupEngineImage } from "./physical-store.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";

type WorkboardStore = {
  ready(): Promise<void>;
  listBoards(): Promise<{ boards: Array<{ id: string; name: string }> }>;
  upsertBoard(input: { id: string; name: string }): Promise<unknown>;
  close(): Promise<void>;
};
type ProofMode = "sqlite" | "state-postgres" | "workboard-postgres";

// Exercise the public plugin API without importing its implementation into core type graphs.
const { WorkboardStore } = await vi.importActual<{
  WorkboardStore: { openSqlite(workerModuleUrl: URL): WorkboardStore };
}>("../../../extensions/workboard/runtime-api.js");
const workerExtension = path.extname(new URL(import.meta.url).pathname);
const workboardWorker = new URL(
  `../../../extensions/workboard/src/sqlite-store.worker${workerExtension}`,
  import.meta.url,
);

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.unstubAllEnvs();
});

async function runProof(stateDir: string, mode: ProofMode) {
  resetDatabaseEngineSelectionForTest();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const secretFile = path.join(stateDir, "connection.json");
  if (mode === "workboard-postgres") {
    fs.writeFileSync(secretFile, JSON.stringify({ dsn: connection }), { mode: 0o600 });
  }
  const config: OpenClawConfig = { database: { engine: "sqlite" } };
  if (mode !== "sqlite") {
    config.database = {
      engine: "sqlite",
      families: { [mode === "state-postgres" ? "state" : "workboard"]: { engine: "postgres" } },
      postgres: { connection, schemaPrefix: "mixed_proof" },
    };
  }
  if (mode === "workboard-postgres") {
    config.database!.postgres!.connection = { source: "file", provider: "database", id: "/dsn" };
    config.secrets = { providers: { database: { source: "file", path: secretFile } } };
  }
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
  await installGatewayDatabaseEngine();
  if (mode === "workboard-postgres") {
    // Later plugin opens must use the boot fact after the SecretRef is unavailable.
    fs.unlinkSync(secretFile);
  }
  const selection = getDatabaseEngineSelection();
  expect(selection).toBeDefined();
  const anchorPath = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
  const engine = () => readBackupEngineImage(anchorPath, anchorPath);
  const boardName = async (store: WorkboardStore) =>
    (await store.listBoards()).boards.find((board) => board.id === "mixed-proof")?.name;
  let workboard: WorkboardStore | undefined;
  try {
    workboard = WorkboardStore.openSqlite(workboardWorker);
    await workboard.ready();
    const initialBoardName = await boardName(workboard);
    await workboard.upsertBoard({ id: "mixed-proof", name: "Mixed proof" });
    await workboard.close();
    workboard = WorkboardStore.openSqlite(workboardWorker);
    await workboard.ready();
    const reopenedBoardName = await boardName(workboard);
    await workboard.close();
    workboard = undefined;
    expect(getDatabaseEngineSelection()).toBe(selection);
    return {
      workboardEngine: engine().engine,
      initialBoardName,
      reopenedBoardName,
    };
  } finally {
    await workboard?.close();
    if (mode === "workboard-postgres" && fs.existsSync(anchorPath)) {
      const physical = engine();
      if (physical.engine === "postgres") {
        expect(physical.namespace).toMatch(/^mixed_proof_workboard_[0-9a-f]{16}$/);
        await withPostgresConnection(selection!.postgres!, (client) =>
          client.query(`DROP SCHEMA IF EXISTS "${physical.namespace}" CASCADE`),
        );
      }
    }
  }
}

async function assertBoot(mode: ProofMode) {
  const result = await runProof(tempDirs.make(`mixed-mode-${mode}-`), mode);
  expect(result).toMatchObject({
    workboardEngine: mode === "workboard-postgres" ? "postgres" : "sqlite",
    reopenedBoardName: "Mixed proof",
  });
}

it("boots SQLite owners and reopens persisted data", () => assertBoot("sqlite"));

describe.skipIf(!connection)("mixed-mode boot conformance", () => {
  it.each(["state-postgres", "workboard-postgres"] as const)(
    "boots %s owners and reopens persisted data",
    assertBoot,
  );

  it("refuses an existing SQLite Workboard override with the port remedy and retains its data", async () => {
    const stateDir = tempDirs.make("mixed-mode-mismatch-");
    await runProof(stateDir, "sqlite");
    await expect(runProof(stateDir, "workboard-postgres")).rejects.toThrow(
      /Existing SQLite workboard data cannot switch engines.*openclaw database port/,
    );
    await expect(runProof(stateDir, "sqlite")).resolves.toMatchObject({
      initialBoardName: "Mixed proof",
      workboardEngine: "sqlite",
      reopenedBoardName: "Mixed proof",
    });
  });
});
