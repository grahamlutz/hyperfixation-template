import { hfRecordColumns } from "@hyperfixation/db";
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The demo record table, and the shape every record table registered with `defineRecord` has
 * to have: a `bigint` identity primary key named `id` (E001), the `hfRecordColumns()` mixin
 * the machinery reads and writes — `archived_at` is the column `records.archive()` sets — and
 * a trigram index on `normalized_name` (E003), which the mixin deliberately leaves to the app
 * to declare.
 */
export const demoNote = pgTable(
  "demo_note",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    ...hfRecordColumns(),
    // Two of the mixin's columns, tightened. The mixin leaves every column nullable and
    // non-unique so that adopting it is an additive migration; this table carried both
    // constraints before the mixin and keeps them — dropping `normalized_name`'s uniqueness
    // would be a migration the app policy refuses, and the unique index is what `demoResolver`'s
    // exact join reads.
    normalizedName: text("normalized_name").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    body: text("body").notNull(),
    contactEmail: text("contact_email"),
  },
  (t) => [index("demo_note_normalized_name_trgm").using("gin", t.normalizedName)],
);
