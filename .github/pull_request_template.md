Chunk: <id from the current phase-order doc, e.g. X1; `misc` for work no chunk asked for>

<!--
Keep the `Chunk:` line first and on its own: core's `pnpm plan:sync` reads it to build the status
table in its phase-order docs. A PR without one never reaches the table.
-->

What this changes, and why, in a few lines.

## Built

Deviations from the plan, findings, timings. The order doc's prose stays reserved for deviations
and decisions, and `plan:sync` never copies this section into it.
