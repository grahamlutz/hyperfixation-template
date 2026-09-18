import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The demo record table, and the shape every record table registered with `defineRecord` has
 * to have: a `bigint` identity primary key named `id` (E001) and a trigram index on
 * `normalized_name` (E003), which is what the resolver matches on.
 */
export const demoNote = pgTable(
  "demo_note",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    // Unique because the demo flow upserts on it: a restarted attempt has to converge on the
    // row its predecessor wrote, and `ON CONFLICT` needs a constraint to converge against.
    normalizedName: text("normalized_name").notNull().unique(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("demo_note_normalized_name_trgm").using("gin", t.normalizedName)],
);
