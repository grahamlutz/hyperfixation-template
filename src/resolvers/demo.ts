import { defineResolver } from "@hyperfixation/core";
import { sql } from "drizzle-orm";
import type { DemoBusiness } from "../sources/demo";

export const DEMO_RESOLVER_NAME = "demoNotes";

/**
 * The resolver: what decides whether a loaded row is a record this app already has.
 *
 * `exactKeys` are **payload keys joined against columns of the same name** on the record type's
 * table — `normalized_name` in the payload against `normalized_name` on `demo_note`. Rename one
 * side and resolution silently stops matching, which is why the source's payload uses the
 * column's spelling rather than a camel-cased one.
 *
 * The exact join runs first; only a miss reaches the trigram pass, and only a fuzzy miss reaches
 * `create`. No `review()` is declared, so any candidate above the threshold links: an app that
 * would rather a human confirmed a borderline match adds one and the row parks as `review`.
 *
 * `create` and `update` write through the `db` resolution hands them, which is the caller's open
 * `ctx.tx` — never a handle of their own. Both are re-run whenever the source row is seen again,
 * so `update` is a plain overwrite of the mutable columns and touches nothing the app owns:
 * `score`, `stage` and `archived_at` are decisions about the record, not facts from the source.
 */
export const demoResolver = defineResolver<DemoBusiness>({
  name: DEMO_RESOLVER_NAME,
  recordType: "demoNote",
  exactKeys: ["normalized_name"],
  fuzzy: { field: "normalized_name", threshold: 0.4 },

  async create(payload, db) {
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO demo_note (normalized_name, body, contact_email)
      VALUES (${payload.normalized_name}, ${payload.body}, ${payload.contact_email})
      RETURNING id::text AS id
    `);
    return { id: inserted.rows[0]!.id };
  },

  async update(id, payload, db) {
    await db.execute(sql`
      UPDATE demo_note
      SET body = ${payload.body}, contact_email = ${payload.contact_email}, updated_at = now()
      WHERE id = ${id}::bigint
    `);
  },
});
