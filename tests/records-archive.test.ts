import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { getClient, resetClient } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, recordTables } from "../src/hyperfixation";

/**
 * `records.archive()` against this app's own record table.
 *
 * It is a schema assertion wearing a behaviour test: archiving is `UPDATE <table> SET
 * archived_at = now()` on the table a record type names, so a record table that does not carry
 * the `hfRecordColumns()` mixin fails this with Postgres's `42703` — undefined column — and in
 * no other suite. The demo flow never archives, so nothing else here would notice.
 */

const APP_MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("records.archive", () => {
  let database: TestDatabase;
  let pool: Pool;
  let client: DBOSClient;

  beforeAll(async () => {
    database = await createTestDatabase({ recordTables, appMigrationsDir: APP_MIGRATIONS });
    pool = new Pool({ connectionString: database.applicationUrl, max: 2 });
    // Boot checks E001–E005 run here, so the mixin's `normalized_name` and the app's trigram
    // index on it are held to E003 before the archive below is attempted.
    client = await getClient({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
      recordTables,
      appMigrationsDir: APP_MIGRATIONS,
    });
    app.attach({ pool, client });
  }, 120_000);

  afterAll(async () => {
    app.detach();
    await resetClient();
    await pool?.end();
    await database?.drop();
  });

  it("sets archived_at on a demo note", async () => {
    const id = await insertNote("acme roofing");

    const result = await app.records.archive({ recordType: "demoNote", recordId: id });

    expect(result.archived).toBe(true);
    expect(await archivedAt(id)).toBeInstanceOf(Date);
  });

  it("writes nothing the second time", async () => {
    const id = await insertNote("second archive");
    const first = await app.records.archive({ recordType: "demoNote", recordId: id });
    const when = await archivedAt(id);

    const second = await app.records.archive({ recordType: "demoNote", recordId: id });

    expect(first.archived).toBe(true);
    expect(second.archived).toBe(false);
    expect(await archivedAt(id)).toEqual(when);
  });

  async function insertNote(normalizedName: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO demo_note (normalized_name, body) VALUES ($1, $2) RETURNING id",
      [normalizedName, "Collected from the demo source."],
    );
    return rows[0]!.id;
  }

  async function archivedAt(id: string): Promise<Date | null> {
    const { rows } = await pool.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM demo_note WHERE id = $1",
      [id],
    );
    return rows[0]?.archived_at ?? null;
  }
});
