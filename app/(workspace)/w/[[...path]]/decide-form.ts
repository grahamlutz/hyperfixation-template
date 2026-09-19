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
 * The item's draft with whatever the human changed written back onto it, or `undefined` when
 * they changed nothing — an unchanged draft must not be posted as an edit, because an edit is
 * a new `edited_draft` row and a re-parse of text this app already parsed.
 *
 * The edit is built on a copy of the stored draft, so a field the form did not carry keeps the
 * value the run wrote. Every leaf arrives as text, which is what `draftFields` flattened and
 * what the type's schema is held to parse.
 */
function editOf(item: InboxItem, formData: FormData): unknown {
  let draft = structuredClone(item.draft);
  let changed = false;
  for (const field of item.fields) {
    const raw = formData.get(editFieldName(item.approvalId, field.path));
    if (typeof raw !== "string") continue;
    const posted = unwrapLines(raw);
    if (posted === field.value) continue;
    draft = setAtPath(draft, field.path, posted);
    changed = true;
  }
  return changed ? draft : undefined;
}

/**
 * A form posts a text area's line breaks as CRLF whatever was in it — that is HTML's own
 * normalisation, not something the human typed. Undone here, or every multi-line draft that
 * nobody touched comes back as an edit of itself.
 */
function unwrapLines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

/** The inverse of a `DraftField.path`: `contacts[0].email` back onto the draft it came from. */
function setAtPath(draft: unknown, path: string, value: string): unknown {
  // A scalar draft has no key; `draftFields` calls it `value` and the whole draft is it.
  if (typeof draft !== "object" || draft === null) return value;

  const tokens = tokensOf(path);
  const last = tokens.pop();
  if (last === undefined) return draft;

  let node: unknown = draft;
  for (const token of tokens) {
    if (typeof node !== "object" || node === null) return draft;
    node = (node as Record<string, unknown>)[token];
  }
  if (typeof node !== "object" || node === null) return draft;
  (node as Record<string, unknown>)[last] = value;
  return draft;
}

function tokensOf(path: string): string[] {
  return path
    .split(".")
    .flatMap((part) => part.split("["))
    .map((token) => (token.endsWith("]") ? token.slice(0, -1) : token))
    .filter((token) => token.length > 0);
}
