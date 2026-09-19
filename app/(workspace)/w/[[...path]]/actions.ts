"use server";
import { labelValues, type LabelValue } from "@hyperfixation/db";
import { revalidatePath } from "next/cache";
import { workspaceRequest } from "@/workspace";

/**
 * The two things a human does to a record from the web.
 *
 * Both are control-plane calls, which is where they are allowed: `labels.add` and
 * `records.archive` refuse to run inside a workflow — an archive from a step would cancel the
 * approvals of the run issuing it — and the web is the only caller they have.
 *
 * Each takes the record from the form rather than from a closure, so each one validates what it
 * was posted. An unregistered record type is core's refusal, not this file's: both calls resolve
 * the type through the registry and throw before they touch a table.
 */

function recordOf(formData: FormData): { recordType: string; recordId: string } {
  const recordType = String(formData.get("recordType") ?? "");
  const recordId = String(formData.get("recordId") ?? "");
  if (recordType === "" || recordId === "") throw new Error("the form named no record");
  return { recordType, recordId };
}

export async function addRecordLabel(formData: FormData): Promise<void> {
  const { app, actor } = await workspaceRequest();
  const { recordType, recordId } = recordOf(formData);
  const value = String(formData.get("value") ?? "");
  if (!isLabelValue(value)) throw new Error(`${value} is not a label value`);

  await app.labels.add({
    recordType,
    recordId,
    target: "record",
    value,
    userId: actor.userId,
  });
  revalidatePath(`/w/${recordType}/${recordId}`);
}

export async function archiveRecord(formData: FormData): Promise<void> {
  const { app, actor } = await workspaceRequest();
  const { recordType, recordId } = recordOf(formData);

  await app.records.archive({ recordType, recordId, userId: actor.userId });
  // The board reads only unarchived rows, so the card disappears from a page this one did not
  // render; both paths are revalidated because the archive changed what each of them returns.
  revalidatePath(`/w/${recordType}/${recordId}`);
  revalidatePath(`/w/${recordType}`);
}

function isLabelValue(value: string): value is LabelValue {
  return (labelValues as readonly string[]).includes(value);
}
