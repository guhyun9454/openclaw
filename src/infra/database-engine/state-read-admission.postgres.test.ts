import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { ensureUserBackgroundSchema } from "../../state/user-background.store.js";
import { createSqliteDatabaseAdmissionRelay } from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { conformanceWorkerResult, spawnConformanceWorker } from "./conformance.test-support.js";
import { getDatabaseEngineSelection } from "./context.js";
import {
  mixedAgentConnection as connection,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
const value = JSON.stringify({ result: "retained" });
type ReadResult = {
  ok: boolean;
  value?: unknown;
  message?: string;
  stack?: string;
  callbackCalls: number;
  transactions: number;
};

function startWorker<Result extends object = ReadResult>(
  state: { env: NodeJS.ProcessEnv; stateDir: string },
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
  const phase = async (name: string) => {
    expect(
      await awaitGateBeforeSettlement(
        once(worker, "message").then(([message]) => message),
        result,
        `Worker exited before ${name}`,
      ),
    ).toMatchObject({ phase: name });
  };
  return {
    result,
    phase,
    async advance(name: string, gate: Int32Array, index = 0) {
      const pending = phase(name);
      release(gate, index);
      await pending;
    },
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
describe.skipIf(!connection).each([false, true])(
  "settles a PostgreSQL read across schema publication (imported snapshot: %s)",
  (importedSnapshot) => {
    const fixture = useMixedAgentPair("postgres", "postgres");
    it("settles or refuses without replaying the read callback", async () => {
      const state = { env: process.env, stateDir: fixture.root };
      const owner = withEngineStoreAdmission(() => openOpenClawStateDatabase());
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
          await reader.phase("reader-begun");
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
        withEngineStoreAdmission(() => ensureUserBackgroundSchema({ env: state.env }));
      const during = importedSnapshot
        ? await withPostgresConnection(getDatabaseEngineSelection()!.postgres!, async (client) => {
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
    });
  },
);

describe.skipIf(!connection).each(["open", "ensure", "raw-fragment"] as const)(
  "keeps %s admission owned across a sibling publication gap",
  (operation) => {
    const fixture = useMixedAgentPair("postgres", "postgres");
    it("retains ownership until publication settles", async () => {
      const state = { env: process.env, stateDir: fixture.root };
      const owner = withEngineStoreAdmission(() => openOpenClawStateDatabase());
      const publisherGate = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
      const readerGate = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
      const publisher = startWorker<{ ok: boolean }>(state, owner.path, true, {
        gate: publisherGate.buffer,
        twoPublications: operation === "open",
        pauseCommit: operation !== "open",
      });
      const published = publisher.result;
      await publisher.phase("publisher-ready");
      if (operation !== "open") {
        await publisher.advance("publisher-committed", publisherGate);
      }
      const reader = startWorker(state, owner.path, false, { gate: readerGate.buffer, operation });
      const read = reader.result;
      try {
        if (operation === "open") {
          await reader.phase("opener-ready");
          await publisher.advance("publication-pending", publisherGate);
          await reader.advance("opener-admitted", readerGate);
          await publisher.advance("first-published", publisherGate, 1);
          await publisher.advance("publication-pending", publisherGate, 2);
          release(readerGate, 1);
        } else {
          await reader.phase("reader-begun");
          await publisher.advance("publication-pending", publisherGate, 2);
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
    });
  },
);
