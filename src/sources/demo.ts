import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineSource, type SourceRow } from "@hyperfixation/core";

/**
 * One row as the demo source yields it. Every key here is a `hf_source_record.payload` key, and
 * two of them are load-bearing elsewhere: `normalized_name` is what `demoResolver` joins and
 * fuzzy-matches on, and it is a column of the same name on `demo_note` — that pairing is the
 * whole of `exactKeys`.
 */
export interface DemoBusiness {
  /** Already normalized by the source. The resolver never normalizes; it only matches. */
  normalized_name: string;
  body: string;
  contact_email: string;
}

export const DEMO_SOURCE_NAME = "demoBusinesses";

const FILE = path.resolve(process.cwd(), "fixtures/sources/demoBusinesses.json");

/**
 * The template's stand-in for a real source — an API page loop, a CSV drop, a scrape. What
 * matters is the shape, not the JSON file: `fetch()` is an async iterable because the loader
 * COPYs it row by row, so a two-hundred-thousand-row source never has to fit in memory. A real
 * source yields as each page arrives; this one yields as it parses.
 *
 * `externalId` is the source's own id for the thing, and it is the loader's upsert key: loading
 * twice moves `last_seen` and nothing else, and a changed payload resets the row to `new` so
 * resolution runs over it again.
 */
export const demoSource = defineSource<DemoBusiness>({
  name: DEMO_SOURCE_NAME,
  recordType: "demoNote",
  async *fetch(): AsyncGenerator<SourceRow<DemoBusiness>> {
    const rows = JSON.parse(await readFile(FILE, "utf8")) as SourceRow<DemoBusiness>[];
    for (const row of rows) yield row;
  },
});
