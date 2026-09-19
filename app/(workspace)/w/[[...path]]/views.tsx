import type {
  HomeView,
  InboxItem,
  RecordView,
  TaskRow,
  WorkspaceNavItem,
} from "@hyperfixation/core/workspace";
import type { CSSProperties, ReactNode } from "react";

/**
 * What the workspace looks like. Plain server components, mobile first, no client bundle: the
 * screens are a list of things a run produced, and the two things a human does to a record —
 * label it, archive it — are forms.
 *
 * Every value on these pages is model output or a row a run wrote, and all of it reaches the
 * DOM through React's text rendering, which escapes it. A draft holding `<img src=x>` is shown
 * as those characters; `dangerouslySetInnerHTML` is banned under `app/(workspace)/**` by ESLint
 * so that stays true by construction rather than by review.
 *
 * The forms' actions arrive as props rather than being imported here, which is what lets a
 * `react-dom/server` test render these screens without Next's server-action runtime.
 */
export type FormAction = (formData: FormData) => void | Promise<void>;

export function Shell({
  nav,
  email,
  children,
}: {
  nav: readonly WorkspaceNavItem[];
  email: string;
  children: ReactNode;
}) {
  return (
    <main style={{ padding: "1rem", maxWidth: "40rem", margin: "0 auto" }}>
      <nav>
        <ul style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", padding: 0, margin: 0, listStyle: "none" }}>
          {nav.map((item) => (
            <li key={item.path}>
              <a href={item.path}>{item.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      {children}
      <footer style={MUTED}>
        <p>Signed in as {email}</p>
      </footer>
    </main>
  );
}

export function HomeScreen({ view, appName }: { view: HomeView; appName: string }) {
  return (
    <>
      <h1>{appName}</h1>

      <section>
        <h2>Approvals</h2>
        {view.approvals.length === 0 ? (
          <p style={MUTED}>Nothing is waiting on you.</p>
        ) : (
          <ul>
            {view.approvals.map((item) => (
              <li key={item.approvalId}>
                <a href={`/w/approvals/${item.approvalId}`}>
                  {item.type} · {item.recordTitle ?? item.flow}
                </a>{" "}
                <span style={MUTED}>{when(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Open tasks</h2>
        {view.tasks.length === 0 ? <p style={MUTED}>None.</p> : <TaskList tasks={view.tasks} />}
      </section>

      <section>
        <h2>Review queue</h2>
        {view.reviewQueue.length === 0 ? (
          <p style={MUTED}>Nothing needs resolving by hand.</p>
        ) : (
          <ul>
            {view.reviewQueue.map((queue) => (
              <li key={queue.source}>
                {queue.source}: {queue.count}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function RecordScreen({
  view,
  labelAction,
  archiveAction,
}: {
  view: RecordView;
  labelAction: FormAction;
  archiveAction: FormAction;
}) {
  const { record, id } = view;
  const archived = view.archivedAt !== null;
  return (
    <>
      <h1>{view.title ?? `${record.recordType} ${id}`}</h1>
      <p style={MUTED}>
        <a href={`/w/${record.recordType}`}>{record.title ?? record.recordType}</a> · {id}
        {archived ? ` · archived ${when(view.archivedAt)}` : ""}
      </p>

      <section>
        <h2>Summary</h2>
        <dl>
          {Object.entries(view.row).map(([column, value]) => (
            <div key={column}>
              <dt style={MUTED}>{column}</dt>
              <dd>{display(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        {/* Both forms carry the record in hidden fields: the action takes what it acts on from
            the form, never from a closure the page happened to have. */}
        <form action={labelAction}>
          <input type="hidden" name="recordType" value={record.recordType} />
          <input type="hidden" name="recordId" value={id} />
          <button type="submit" name="value" value="up">
            Label up
          </button>{" "}
          <button type="submit" name="value" value="down">
            Label down
          </button>
        </form>
        {archived ? null : (
          <form action={archiveAction}>
            <input type="hidden" name="recordType" value={record.recordType} />
            <input type="hidden" name="recordId" value={id} />
            <button type="submit">Archive</button>
          </form>
        )}
      </section>

      <section>
        <h2>Timeline</h2>
        {view.timeline.length === 0 ? (
          <p style={MUTED}>Nothing has happened to this record yet.</p>
        ) : (
          view.timeline.map((group) => (
            <article key={group.runId ?? "manual"}>
              {/* A group with no run is what a human did from this page; core groups those
                  together and leaves them unnamed, because only the app knows what to call it. */}
              <h3>{group.runId === null ? "manual" : (group.flow ?? group.runId)}</h3>
              <p style={MUTED}>{group.runId === null ? "by hand" : `run ${group.runId}`}</p>
              <ul>
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.kind}</strong> <span style={MUTED}>{when(entry.at)}</span>
                    {entry.body === null ? null : <div>{entry.body}</div>}
                  </li>
                ))}
              </ul>
            </article>
          ))
        )}
      </section>

      <section>
        <h2>Pending approvals</h2>
        {view.pendingApprovals.length === 0 ? (
          <p style={MUTED}>None.</p>
        ) : (
          view.pendingApprovals.map((item) => <DraftFields key={item.approvalId} item={item} />)
        )}
      </section>

      <section>
        <h2>Labels</h2>
        {view.labels.length === 0 ? (
          <p style={MUTED}>None.</p>
        ) : (
          <ul>
            {view.labels.map((label) => (
              <li key={label.id}>
                {label.value} on {label.target}
                {label.targetId === null ? "" : ` ${label.targetId}`}{" "}
                <span style={MUTED}>{when(label.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Outcomes</h2>
        {view.outcomes.length === 0 ? (
          <p style={MUTED}>None.</p>
        ) : (
          <ul>
            {view.outcomes.map((outcome) => (
              <li key={outcome.id}>
                {outcome.outcome} <span style={MUTED}>{when(outcome.at)}</span>
                {outcome.notes === null ? null : <div>{outcome.notes}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Tasks</h2>
        {view.tasks.length === 0 ? <p style={MUTED}>None.</p> : <TaskList tasks={view.tasks} />}
      </section>
    </>
  );
}

/** A route the workspace serves and a later PR renders: C6.5 the inbox. */
export function Placeholder({ title, coming }: { title: string; coming: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p style={MUTED}>{coming}</p>
    </>
  );
}

function DraftFields({ item }: { item: InboxItem }) {
  return (
    <article>
      <h3>
        <a href={`/w/approvals/${item.approvalId}`}>{item.type}</a>{" "}
        <span style={MUTED}>{item.editable ? "editable" : "read-only"}</span>
      </h3>
      <dl>
        {item.fields.map((field) => (
          <div key={field.path}>
            <dt style={MUTED}>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function TaskList({ tasks }: { tasks: readonly TaskRow[] }) {
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id}>
          {task.title}{" "}
          <span style={MUTED}>
            {task.dueAt === null ? task.origin : `due ${when(task.dueAt)}`}
            {task.recordType === null || task.recordId === null ? "" : " · "}
          </span>
          {task.recordType === null || task.recordId === null ? null : (
            <a href={`/w/${task.recordType}/${task.recordId}`}>open</a>
          )}
        </li>
      ))}
    </ul>
  );
}

export function when(at: Date | null): string {
  return at === null ? "—" : at.toISOString();
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString();
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export const MUTED: CSSProperties = { opacity: 0.7, fontSize: "0.875rem" };
