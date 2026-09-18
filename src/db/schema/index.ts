/**
 * This app's own tables, and only this app's. Every `hf_*` table belongs to
 * `@hyperfixation/db` and is migrated by core; an app migration that creates, alters or drops
 * one fails boot check E005, and a foreign key from here to one fails E004.
 *
 * `hf new` leaves the demo table below in place. `.claude/skills/replace-demo/` is the guided
 * way to swap it for the app's real domain.
 */
export { demoNote } from "./demo";
