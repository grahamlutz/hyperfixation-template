import { randomUUID } from "node:crypto";
import type { AppWorkspace, InboxItem } from "@hyperfixation/core/workspace";
import { ApprovalBatchRefused, type DecideResult } from "@hyperfixation/workflows";
import type { WorkspaceActor } from "@/workspace";

/**
 * One posted inbox form, turned into the single `app.workspace.decide` call it stands for.
 *
 * It is a plain module rather than the `"use server"` one beside it on purpose: everything
 * exported from a server-action file is an endpoint, and this is the half worth testing without
 * Next's runtime — the ids, the edits rebuilt from their flattened paths, the replay key, and
 * the refusal turned into a sentence rather than a 500.
 *
 * Nothing here decides *whether* a row may be decided. The assignee rule, the schema an edited
 * draft is parsed against and the replay are all `decide()`'s, inside its locked transaction;
 * this file's job is to hand it what the human posted and to let its refusal be read.
 */

/** The two a button on this page may post; `expired` and `cancelled` are nobody's click. */
const WEB_DECISIONS = ["approved", "rejected"] as const;
type WebDecision = (typeof WEB_DECISIONS)[number];

/** Long refusals travel back in a query string, so the page gets a sentence, not an essay. */
const MAX_ERROR = 600;

/** How a refused batch travels back to the page that posted it. */
export const DECIDE_ERROR_PARAM = "error";

/** A draft field's form name: the approval it belongs to, and the path `draftFields` gave it. */
export function editFieldName(approvalId: number, path: string): string {
  return `edit:${approvalId}:${path}`;
}

export interface DecideDeps {
  workspace: Pick<AppWorkspace, "inbox" | "decide">;
  actor: WorkspaceActor;
}

export interface DecideOutcome {
  /** Set when the batch was refused: readable, and nothing was written. */
  error?: string;
  result?: DecideResult;
  /** The records the decision changed, for whoever revalidates their pages. */
  records: { recordType: string; recordId: string }[];
}

export async function decideFromForm(
  deps: DecideDeps,
  formData: FormData,
): Promise<DecideOutcome> {
  const decision = decisionOf(formData);
  if (decision === undefined) return { error: "That is not a decision this page makes.", records: [] };

  const ids = idsOf(formData);
  if (ids.length === 0) return { error: "Select at least one approval first.", records: [] };

  // Read back what this session may see: an edit is rebuilt onto the draft the row actually
  // holds rather than onto anything the form claimed, and these rows name the record pages the
  // decision changes. An id that is not here is still passed on — whether it may be decided is
  // the assignee rule's answer, and its refusal is the honest message.
  const { items } = await deps.workspace.inbox({
    userId: deps.actor.userId,
    admin: deps.actor.admin,
  });
  const byId = new Map(items.map((item) => [item.approvalId, item]));

  const edits: Record<number, unknown> = {};
  for (const id of ids) {
    const item = byId.get(id);
    if (item === undefined || !item.editable) continue;
    const edited = editOf(item, formData);
    if (edited !== undefined) edits[id] = edited;
  }

  const records = ids.flatMap((id) => {
    const item = byId.get(id);
    if (item === undefined || item.recordType === null || item.recordId === null) return [];
    return [{ recordType: item.recordType, recordId: item.recordId }];
  });

  try {
    const result = await deps.workspace.decide({
      ids,
      decision,
      decisionKey: keyOf(formData),
      userId: deps.actor.userId,
      admin: deps.actor.admin,
      ...(Object.keys(edits).length > 0 ? { edits } : {}),
    });
    return { result, records };
  } catch (error) {
    // The one failure that is an answer rather than a fault: a row somebody else is assigned,
    // an edit the type's schema rejects, a key that decided a different batch.
    if (!(error instanceof ApprovalBatchRefused)) throw error;
    return { error: error.message.slice(0, MAX_ERROR), records: [] };
  }
}

function decisionOf(formData: FormData): WebDecision | undefined {
  const value = String(formData.get("decision") ?? "");
  return (WEB_DECISIONS as readonly string[]).includes(value)
    ? (value as WebDecision)
    : undefined;
}

/** `hf_approval.id` is a bigint identity, so anything else in a checkbox is not an approval. */
function idsOf(formData: FormData): number[] {
  const ids = formData
    .getAll("ids")
    .map((value) => Number(String(value)))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)];
}

/** A form that carried no key still decides; it just has no replay window of its own. */
function keyOf(formData: FormData): string {
  const key = String(formData.get("decisionKey") ?? "").trim();
  return key === "" || key.length > 100 ? randomUUID() : key;
}

/**
 * Which of an item's fields may be offered as a text box, and are therefore the only ones an
 * edit is ever taken from.
 *
 * A `DraftField.path` is a description of where a value came from, not a key: `draftFields`
 * joins object keys with `.` without escaping them, so two different places in a draft can
 * flatten to the same path and a path can name a place that does not exist. Both are refused
 * here rather than guessed at, because the guess would be an edit written to the wrong value.
 *
 * A path is offered only when it is the only field with that path, and when walking it through
 * the draft's own properties — never the prototype chain, and never through `__proto__`,
 * `constructor` or `prototype` — arrives at an existing scalar. So a draft holding the literal
 * key `"a.b"` flattens to a path that resolves to nothing and is shown read-only, which is the
 * intended answer: unreachable is safer than approximately reachable. A bare scalar draft is
 * read-only for the same reason — it has no slot to write into.
 */
export function editablePaths(item: InboxItem): Set<string> {
  if (!item.editable) return new Set();
  const counts = new Map<string, number>();
  for (const field of item.fields) {
    counts.set(field.path, (counts.get(field.path) ?? 0) + 1);
  }
  const paths = new Set<string>();
  for (const field of item.fields) {
    if (counts.get(field.path) !== 1) continue;
    if (locate(item.draft, field.path) === undefined) continue;
    paths.add(field.path);
  }
  return paths;
}

/**
 * The item's draft with whatever the human changed written back onto it, or `undefined` when
 * they changed nothing — an unchanged draft must not be posted as an edit, because an edit is
 * a new `edited_draft` row and a re-parse of text this app already parsed.
 *
 * The edit is built on a copy of the stored draft, so a field the form did not carry keeps the
 * value the run wrote. Every leaf arrives as text, which is what `draftFields` flattened and
 * what the type's schema is held to parse.
 */
function editOf(item: InboxItem, formData: FormData): unknown {
  const editable = editablePaths(item);
  if (editable.size === 0) return undefined;

  const draft = structuredClone(item.draft);
  let changed = false;
  for (const field of item.fields) {
    if (!editable.has(field.path)) continue;
    const raw = formData.get(editFieldName(item.approvalId, field.path));
    if (typeof raw !== "string") continue;
    const posted = oneLineEnding(raw);
    if (posted === oneLineEnding(field.value)) continue;
    // Located again on the copy: the same walk, over the object about to be written.
    const slot = locate(draft, field.path);
    if (slot === undefined) continue;
    slot.container[slot.key] = posted;
    changed = true;
  }
  return changed ? draft : undefined;
}

/**
 * Line endings, as `\n`, on both sides of the comparison.
 *
 * A form posts a text area's breaks as CRLF whatever was in it — HTML's own normalisation, not
 * something the human typed — so a stored draft holding CRLF would otherwise come back as an
 * edit of itself. What this does **not** preserve is a stored CR: a field whose value really
 * did hold `\r\n` and which the human then edits is written back with `\n`, because there is
 * no way to tell the browser's CRLF from theirs. A value holding any break is rendered in a
 * text area for this reason (`inbox.tsx`); a single-line input strips them outright.
 */
function oneLineEnding(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** The own-property slot a `DraftField.path` names, or `undefined` when it names none. */
interface Slot {
  container: Record<string, unknown>;
  key: string;
}

/** Never walked through: each is a way to reach an object no draft owns. */
const UNSAFE_TOKENS = new Set(["__proto__", "constructor", "prototype"]);

function locate(draft: unknown, path: string): Slot | undefined {
  const tokens = tokensOf(path);
  if (tokens.length === 0 || tokens.some((token) => UNSAFE_TOKENS.has(token))) return undefined;

  const key = tokens[tokens.length - 1]!;
  let node: unknown = draft;
  for (const token of tokens.slice(0, -1)) {
    if (!ownsKey(node, token)) return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  if (!ownsKey(node, key)) return undefined;
  const value = (node as Record<string, unknown>)[key];
  // A container is not a leaf: `draftFields` gives containers no row of their own, so a path
  // that lands on one is a path that named something else.
  if (typeof value === "object" && value !== null) return undefined;
  return { container: node as Record<string, unknown>, key };
}

function ownsKey(node: unknown, token: string): boolean {
  return typeof node === "object" && node !== null && Object.hasOwn(node, token);
}

function tokensOf(path: string): string[] {
  return path
    .split(".")
    .flatMap((part) => part.split("["))
    .map((token) => (token.endsWith("]") ? token.slice(0, -1) : token))
    .filter((token) => token.length > 0);
}
