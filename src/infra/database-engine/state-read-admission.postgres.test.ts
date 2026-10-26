import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { getEnvironmentData, type Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { ensureUserBackgroundSchema } from "../../state/user-background.store.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { getSqliteDatabaseSchemaRevision } from "../sqlite-database-admission.js";
import { createSqliteDatabaseAdmissionRelay } from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { conformanceWorkerResult, spawnConformanceWorker } from "./conformance.test-support.js";
import { getDatabaseEngineSelection, installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const value = JSON.stringify({ result: "retained" });
type ReadResult = {
  ok: boolean;
  value?: unknown;
  message?: string;
  stack?: string;
  callbackCalls: number;
  transactions: number;
};

async function withState(
  run: (
    state: OpenClawTestState,
    owner: ReturnType<typeof openOpenClawStateDatabase>,
    postgres: { connection: string; schemaPrefix: string },
  ) => Promise<void>,
) {
  const postgres = {
    connection: connection!,
    schemaPrefix: `state_read_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  };
  try {
    await withOpenClawTestState({ label: "state-read-admission" }, async (state) => {
      installDatabaseEngineSelection({
        effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
        postgres,
      });
      const owner = withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: state.env }));
      await run(state, owner, postgres);
    });
  } finally {
    closeOpenClawStateDatabaseForTest();
    resetDatabaseEngineSelectionForTest();
    await withPostgresConnection(postgres, (client) =>
      dropPostgresTestSchemas(client, postgres.schemaPrefix),
    );
  }
}

function startWorker<Result extends object = ReadResult>(
  state: OpenClawTestState,
  location: string,
  publisher: boolean,
  input: object,
  assertCurrent = () => {},
) {
  const relay = createSqliteDatabaseAdmissionRelay(assertCurrent);
  const sourceWorkerName = publisher
    ? "state-read-admission-publication.worker.test-support"
    : "state-read-admission.worker.test-support";
  const { anchor, worker } = spawnConformanceWorker(
    {
      currentModuleUrl: import.meta.url,
      sourceWorkerName,
      distWorkerPath: `infra/database-engine/${sourceWorkerName}.js`,
    },
    location,
    {
      path: location,
      environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir },
      selection: getDatabaseEngineSelection(),
      ...input,
    },
  );
  worker.postMessage({ admissionPort: relay.port }, [relay.port]);
  const result = conformanceWorkerResult<Result>(
    worker,
    publisher ? "Publisher" : "State admission",
  );
  return {
    worker,
    result,
    finish() {
      relay.finish();
      anchor.close();
    },
  };
}

const release = (gate: Int32Array, index = 0) => {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
};
async function phase(worker: Worker, result: Promise<object>, name: string) {
  expect(
    await awaitGateBeforeSettlement(
      once(worker, "message").then(([message]) => message),
      result,
      `Worker exited before ${name}`,
    ),
  ).toMatchObject({ phase: name });
}

it.skipIf(!connection).each([false, true])(
  "settles a PostgreSQL read across schema publication (imported snapshot: %s)",
  async (importedSnapshot) =>
    withState(async (state, owner, postgres) => {
      withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            ).run("admission.fixture", value, 1);
          },
          { database: owner, env: state.env },
        ),
      );
      const read = async (
        publish: () => void,
        options?: { snapshot?: string; throwFromCallback?: boolean },
      ) => {
        let active = true;
        const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        const reader = startWorker(
          state,
          owner.path,
          false,
          { gate: gate.buffer, ...options },
          () => {
            if (!active) {
              throw new Error("State admission fixture has finished");
            }
          },
        );
        try {
          await phase(reader.worker, reader.result, "reader-begun");
          publish();
          release(gate);
          return await reader.result;
        } finally {
          release(gate);
          await reader.result.catch(() => {});
          active = false;
          reader.finish();
        }
      };
      const before = await read(() => {});
      const publish = () =>
        withEngineStoreAdmission(() => {
          const hasBackground = () =>
            getPostgresPhysicalFacts(owner.db)?.catalog.some(
              (fact) => fact.table === "user_background_images",
            );
          expect(hasBackground()).toBe(false);
          const beforeRevision = getSqliteDatabaseSchemaRevision(owner.db);
          ensureUserBackgroundSchema({ env: state.env });
          expect(hasBackground()).toBe(true);
          expect(getSqliteDatabaseSchemaRevision(owner.db)).toBeGreaterThan(beforeRevision!);
        });
      const during = importedSnapshot
        ? await withPostgresConnection(postgres, async (client) => {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            try {
              const exported = await client.query<{ snapshot: string }>(
                "SELECT pg_export_snapshot() AS snapshot",
              );
              const snapshot = exported.rows[0]?.snapshot;
              if (!snapshot) {
                throw new Error("State admission fixture could not export its snapshot");
              }
              return await read(publish, { snapshot });
            } finally {
              await client.query("ROLLBACK");
            }
          })
        : await read(publish);
      const after = await read(() => {});
      expect(before).toMatchObject({ ok: true, value, callbackCalls: 1, transactions: 1 });
      expect(after).toMatchObject({ ok: true, value, callbackCalls: 1, transactions: 1 });
      expect(during).toMatchObject(
        importedSnapshot
          ? {
              ok: false,
              message: "Missing PostgreSQL physical schema admission",
              callbackCalls: 0,
              transactions: 1,
            }
          : { ok: true, value, callbackCalls: 1, transactions: 2 },
      );
      if (!importedSnapshot) {
        expect(await read(() => {}, { throwFromCallback: true })).toMatchObject({
          ok: false,
          message: "Callback admission failed",
          callbackCalls: 1,
          transactions: 1,
        });
      }
    }),
);

it.skipIf(!connection).each(["open", "ensure", "raw-fragment"] as const)(
  "keeps %s admission owned across a sibling publication gap",
  async (operation) =>
    withState(async (state, owner) => {
      const publisherGate = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
      const readerGate = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
      const publisher = startWorker<{ ok: boolean }>(state, owner.path, true, {
        gate: publisherGate.buffer,
        twoPublications: operation === "open",
        pauseCommit: operation !== "open",
      });
      const published = publisher.result;
      await phase(publisher.worker, published, "publisher-ready");
      if (operation !== "open") {
        const committed = phase(publisher.worker, published, "publisher-committed");
        release(publisherGate);
        await committed;
      }
      const reader = startWorker(state, owner.path, false, { gate: readerGate.buffer, operation });
      const read = reader.result;
      try {
        if (operation === "open") {
          await phase(reader.worker, read, "opener-ready");
          const pending = phase(publisher.worker, published, "publication-pending");
          release(publisherGate);
          await pending;
          const admitted = phase(reader.worker, read, "opener-admitted");
          release(readerGate);
          await admitted;
          const firstPublished = phase(publisher.worker, published, "first-published");
          release(publisherGate, 1);
          await firstPublished;
          const secondPending = phase(publisher.worker, published, "publication-pending");
          release(publisherGate, 2);
          await secondPending;
          release(readerGate, 1);
        } else {
          await phase(reader.worker, read, "reader-begun");
          const pending = phase(publisher.worker, published, "publication-pending");
          release(publisherGate, 2);
          await pending;
          release(readerGate);
        }
        await delay(50);
        release(publisherGate, operation === "open" ? 3 : 1);
        const result = await read;
        if (operation === "raw-fragment") {
          expect(result).toMatchObject({
            ok: false,
            admissionError: true,
            callbackCalls: 1,
            transactions: 1,
          });
          expect(result.message).toContain("Missing PostgreSQL state admission");
          expect(result.stack).toContain("ensureStatePostgresFragment");
        } else {
          expect(result, result.stack).toMatchObject({
            ok: true,
            value: operation === "open" ? { admitted: 1 } : { count: 0 },
          });
          if (operation === "ensure") {
            expect(result.transactions).toBe(2);
          }
        }
      } finally {
        for (let index = 0; index < publisherGate.length; index++) {
          release(publisherGate, index);
        }
        for (let index = 0; index < readerGate.length; index++) {
          release(readerGate, index);
        }
        await Promise.allSettled([published, read]);
        publisher.finish();
        reader.finish();
      }
    }),
);
