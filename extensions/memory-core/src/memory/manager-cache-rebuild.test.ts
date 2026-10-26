import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory rebuild cache reuse", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { paths, createConfig, getFreshManager, provider } = fixture;
  const cacheConfig = (vectorEnabled: boolean, model?: string) =>
    createConfig({ sources: ["memory"], cacheEnabled: true, vectorEnabled, model });
  const count = (db: DatabaseSync, table: string) =>
    db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "embeds only initial misses and settles capacity (empty=%s)",
    async (emptyIndex) => {
      await fs.rm(path.join(paths.memory, "2026-01-12.md"));
      const manager = await getFreshManager(cacheConfig(true));
      (manager as unknown as { cache: { maxEntries?: number } }).cache.maxEntries = 12;
      for (let i = 0; i < 12; i += 1) {
        await fs.writeFile(
          path.join(paths.memory, `${String(i).padStart(2, "0")}.md`),
          `cached text ${i}`,
        );
      }
      await manager.sync({ reason: "cli", force: true });
      const writer = memoryIndexFixtureWriter(manager);
      writer.exec(`DELETE FROM memory_embedding_cache WHERE hash IN (
        SELECT hash FROM memory_index_chunks WHERE path < 'memory/04.md'
      ); UPDATE memory_embedding_cache SET updated_at = 1;`);
      const insert = writer.prepare(`INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
        SELECT provider, model, provider_key, ?, ?, 4, ? FROM memory_embedding_cache LIMIT 1`);
      for (let i = 0; i < 4; i += 1) {
        insert.run(`superseded-${i}`, encodeMemoryEmbedding([0, 0, 0, 0]), Date.now() + i);
      }
      expect(count(writer, "memory_embedding_cache")).toEqual({ n: 12 });
      if (emptyIndex) {
        writer.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources;");
      }
      provider.embeddedBatchTexts.length = 0;
      await manager.sync({ reason: "cli", force: true });

      expect(provider.embeddedBatchTexts.toSorted()).toEqual(
        emptyIndex ? ["cached text 0", "cached text 1", "cached text 2", "cached text 3"] : [],
      );
      expect(count(writer, "memory_index_chunks")).toEqual({ n: 12 });
      expect(count(writer, "memory_embedding_cache")).toEqual({ n: 12 });
      if (!emptyIndex) {
        await manager.close();
        const changedModel = await getFreshManager(cacheConfig(true, "different-embedding-model"));
        provider.embeddedBatchTexts.length = 0;
        await changedModel.sync({ reason: "cli", force: true });
        expect(provider.embeddedBatchTexts.toSorted()).toEqual(
          Array.from({ length: 12 }, (_, i) => `cached text ${i}`).toSorted(),
        );
      }
    },
  );

  it.each(["incremental", "full"] as const)("bounds every %s cache transaction", async (mode) => {
    await fs.rm(path.join(paths.memory, "2026-01-12.md"));
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
    const interceptedPaths: Array<string | undefined> = [];
    // Install before manager startup can retain its canonical publication client.
    vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2").mockImplementation(
      async (...args) => {
        const [options, source, worker] = args;
        if (
          options.agentId !== "main" ||
          options.path !== databasePath ||
          worker.moduleUrl.href !==
            resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication).href
        ) {
          return await open(...args);
        }
        const client = await open(options, source, {
          ...worker,
          moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
          input: {
            kind: "cache-capacity",
            publication: worker.input,
            maximum: mode === "full" ? 4 : 2,
          },
        });
        interceptedPaths.push(options.path);
        return client;
      },
    );
    const memoryManager = await getFreshManager(cacheConfig(false));
    const harness = memoryManager as unknown as {
      cache: { maxEntries?: number };
      dirty: boolean;
      db: DatabaseSync;
    };
    harness.cache.maxEntries = 2;
    await memoryManager.sync({ reason: "cli", force: true });
    const files = mode === "full" ? 5 : 4;
    for (let i = 0; i < files; i += 1) {
      await fs.writeFile(path.join(paths.memory, `${i}.md`), `unique cache content ${i}`);
    }
    // Full rebuilds may use twice the cap; every commit must stay within its
    // budget, and completion restores the normal cap.
    harness.dirty = true;
    await memoryManager.sync({ reason: "cli", force: mode === "full" });

    expect(interceptedPaths.length).toBeGreaterThan(0);
    expect(interceptedPaths.every((filename) => filename === harness.db.location())).toBe(true);
    expect(count(harness.db, "memory_embedding_cache")).toEqual({ n: 2 });
    expect(count(harness.db, "memory_index_sources")).toEqual({ n: files });
  });
});
