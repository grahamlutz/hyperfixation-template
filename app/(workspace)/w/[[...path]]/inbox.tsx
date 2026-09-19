import { randomUUID } from "node:crypto";
import { approvalPath, type InboxItem, type InboxView } from "@hyperfixation/core/workspace";
import { editFieldName } from "./decide-form";
import { DecisionKey } from "./decision-key";
import { MUTED, when, type FormAction } from "./views";

/**
 * The approval inbox: every pending row this session may see, in one form.
 *
 * One form, because one submission is one `decide()` call — the batch is decided inside a
 * single locked transaction or not at all, and a page that posted a request per row would give
 * a human a half-applied batch to reason about. The checkboxes choose the rows, the two buttons
 * choose the decision, and the text boxes are the draft itself.
 *
 * A draft is model output. It reaches the DOM as an input's `defaultValue` or as a text node,
 * both of which React escapes, and `dangerouslySetInnerHTML` is banned under
 * `app/(workspace)/**` — `tests/inbox-render.test.tsx` is the other half of that claim.
 *
 * An edit is only *offered* on an item core calls `editable`, which is an approval type with a
 * registered schema: without one there is nothing to parse an edited draft against, and
 * `decide()` refuses the batch rather than writing text nobody validated.
 */

/** Anything longer, or with a line in it, gets a box instead of a line. */
const TEXTAREA_OVER = 80;

export function InboxScreen({
  view,
  decideAction,
  error,
}: {
  view: InboxView;
  decideAction: FormAction;
  error?: string | undefined;
}) {
  return (
    <>
      <h1>Inbox</h1>
      <p style={MUTED}>
        {view.items.length} pending · {view.mine} yours · {view.unassigned} unassigned
      </p>
      {error === undefined ? null : <ErrorNote error={error} />}
      {view.items.length === 0 ? (
        <p style={MUTED}>Nothing is waiting on you.</p>
      ) : (
        <DecideForm items={view.items} action={decideAction} returnTo="/w/approvals" selectable />
      )}
    </>
  );
}

/**
 * One approval on its own page — what the notifier's email links to. Same form and same action;
 * the row is carried in a hidden field rather than a checkbox, because a page about one
 * approval offers no choice of which.
 */
export function ApprovalScreen({
  item,
  decideAction,
  error,
}: {
  item: InboxItem;
  decideAction: FormAction;
  error?: string | undefined;
}) {
  return (
    <>
      <h1>{item.type}</h1>
      <p style={MUTED}>
        approval {item.approvalId} · {item.flow}
      </p>
      {error === undefined ? null : <ErrorNote error={error} />}
      <DecideForm
        items={[item]}
        action={decideAction}
        returnTo={approvalPath(item.approvalId)}
        selectable={false}
      />
    </>
  );
}

function DecideForm({
  items,
  action,
  returnTo,
  selectable,
}: {
  items: readonly InboxItem[];
  action: FormAction;
  returnTo: string;
  selectable: boolean;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <DecisionKey seed={randomUUID()} />
      {items.map((item) => (
        <ApprovalRow key={item.approvalId} item={item} selectable={selectable} />
      ))}
      <p>
        <button type="submit" name="decision" value="approved">
          Approve
        </button>{" "}
        <button type="submit" name="decision" value="rejected">
          Reject
        </button>
      </p>
    </form>
  );
}

function ApprovalRow({ item, selectable }: { item: InboxItem; selectable: boolean }) {
  return (
    <article style={ROW}>
      <h2 style={HEADING}>
        {selectable ? (
          <label>
            <input type="checkbox" name="ids" value={item.approvalId} /> {item.type}
          </label>
        ) : (
          <>
            {item.type}
            <input type="hidden" name="ids" value={item.approvalId} />
          </>
        )}
      </h2>
      <p style={MUTED}>
        {item.recordType === null || item.recordId === null ? (
          item.flow
        ) : (
          <a href={`/w/${item.recordType}/${item.recordId}`}>
            {item.recordTitle ?? `${item.recordType} ${item.recordId}`}
          </a>
        )}{" "}
        · {item.assigneeId === null ? "unassigned" : `assigned to ${item.assigneeId}`} ·{" "}
        {item.expiresAt === null ? "no expiry" : `expires ${when(item.expiresAt)}`}
        {selectable ? (
          <>
            {" "}
            · <a href={approvalPath(item.approvalId)}>open</a>
          </>
        ) : null}
      </p>
      {item.editable ? (
        item.fields.map((field) => (
          <p key={field.path}>
            <label>
              <span style={MUTED}>{field.label}</span>
              <br />
              <Editor name={editFieldName(item.approvalId, field.path)} value={field.value} />
            </label>
          </p>
        ))
      ) : (
        <dl>
          {item.fields.map((field) => (
            <div key={field.path}>
              <dt style={MUTED}>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {item.editable ? null : (
        <p style={MUTED}>This type registers no schema, so its draft cannot be edited here.</p>
      )}
    </article>
  );
}

function Editor({ name, value }: { name: string; value: string }) {
  return value.length > TEXTAREA_OVER || value.includes("\n") ? (
    <textarea name={name} defaultValue={value} rows={6} style={FIELD} />
  ) : (
    <input type="text" name={name} defaultValue={value} style={FIELD} />
  );
}

/** A refused batch, said out loud. Nothing was written; the rows are all still pending. */
function ErrorNote({ error }: { error: string }) {
  return (
    <p role="alert" style={ALERT}>
      {error}
    </p>
  );
}

const ROW = { borderTop: "1px solid", paddingTop: "0.5rem", marginTop: "0.5rem" } as const;
const HEADING = { fontSize: "1rem", margin: "0 0 0.25rem" } as const;
const FIELD = { width: "100%", boxSizing: "border-box" } as const;
const ALERT = { border: "1px solid", padding: "0.5rem" } as const;
