/**
 * Honest handoff copy for solicitation fields a vendor cannot reach from
 * public records (procurement-pursuit-decision, card "PPD-07").
 *
 * The pursuit snapshot already carries a fixed disclosure of what CityScroll
 * cannot verify, and already tells a vendor that the solicitation package and
 * the question-and-answer content require signing in to the vendor portal.
 * This module extends that register from a measured classification instead of
 * a hand-kept list: given the access classification produced by the
 * `access_feasibility` research lane
 * (docs/research/procurement-access-classification/classification.json), it
 * produces the line the handoff surface shows for each field the vendor
 * cannot reach -- what requires signing in, or what no public source this
 * product observes carries at all.
 *
 * Two rules this module exists to hold:
 *
 *   1. The last-observed date comes from the record being displayed. It is
 *      never read from the clock. A clock reading would tell a vendor that a
 *      stale record is fresh, which is the exact failure this copy exists to
 *      prevent. Nothing here calls Date.now() or constructs a current date.
 *   2. A field the classification could not settle (`unstable`) produces no
 *      line at all. Saying "we could not tell" as though it were a finding
 *      would put a research limitation in front of a vendor as a fact about
 *      their opportunity.
 *
 * Pure and offline: no network client, no browser client, no storage. The
 * caller supplies the classification document and the record.
 */

import { shortDate } from "./digest_item_awareness.mjs";

export const PROCUREMENT_HANDOFF_COPY_SCHEMA = "cityscroll.procurement_handoff_copy.v1";

/** The classification's class vocabulary, in the order the file declares it. */
export const HANDOFF_ACCESS_CLASSES = Object.freeze(["accessible", "authenticated", "unavailable", "unstable"]);

/** The only classes that produce handoff copy. See rule 2 in the module doc. */
export const HANDOFF_INFEASIBLE_CLASSES = Object.freeze(["authenticated", "unavailable"]);

/**
 * Record fields a last-observed date may come from, in priority order. All of
 * them are properties of the record itself; none of them is a clock.
 */
export const HANDOFF_LAST_OBSERVED_FIELDS = Object.freeze([
  "last_observed_at",
  "observed_at",
  "retrieval_timestamp",
  "retrieved_at",
  "ingested_at",
]);

function text(value) {
  return String(value ?? "").trim();
}

/**
 * "Aug 5, 2026" from an ISO-shaped date, reusing the existing month vocabulary
 * rather than restating it. Returns "" for anything that is not ISO-shaped --
 * an unparseable stamp yields no date sentence rather than a guess.
 */
export function handoffObservedDateLabel(value) {
  const stamp = text(value);
  const day = shortDate(stamp);
  if (!day) return "";
  const year = /^(\d{4})-/.exec(stamp);
  return year ? `${day}, ${year[1]}` : day;
}

/**
 * The last-observed date carried by this record, or null. Never a clock
 * reading, and never a value inferred from an adjacent field.
 */
export function lastObservedFromRecord(record = {}) {
  const source = record && typeof record === "object" ? record : {};
  for (const field of HANDOFF_LAST_OBSERVED_FIELDS) {
    const value = text(source[field]);
    if (value) return value;
  }
  return null;
}

/** The classification entry for one field id, or null. */
export function accessClassificationField(classification, fieldId) {
  const fields = Array.isArray(classification?.fields) ? classification.fields : [];
  return fields.find((field) => field && field.id === fieldId) || null;
}

/** The class one field carries in this classification, or null if unexamined. */
export function accessClassFor(classification, fieldId) {
  const field = accessClassificationField(classification, fieldId);
  const value = text(field?.class);
  return HANDOFF_ACCESS_CLASSES.includes(value) ? value : null;
}

/**
 * A field label as it reads mid-sentence. Only a plain capitalized word is
 * lowered; an identifier-bearing label (PIN / EPIN) keeps its own casing.
 */
function midSentenceLabel(label) {
  return /^[A-Z][a-z]/.test(label) ? `${label[0].toLowerCase()}${label.slice(1)}` : label;
}

/**
 * Both sentences are built around the requirement rather than the field, so
 * the copy reads correctly whether the label is singular or plural, and so
 * neither line announces a gap in this product's own data -- it says what the
 * vendor's next step is, or that there is not one.
 */
function accessSentence(field) {
  const label = midSentenceLabel(text(field.label) || text(field.id));
  if (field.class === "authenticated") {
    const system = text(field.sign_in_system);
    return system
      ? `${system} sign-in is required to reach the ${label}.`
      : `Signing in to the publisher's system is required to reach the ${label}.`;
  }
  return `No public source CityScroll observes carries the ${label}.`;
}

/**
 * The handoff line for one field, or null when the field is reachable, was
 * not examined, or could not be settled by the classification.
 *
 * `record` is the record being displayed. Its last-observed date, when it has
 * one, is appended in the same words the shipped pursuit snapshot already
 * uses; when it has none, the line simply carries no date.
 */
export function handoffCopyForField(classification, fieldId, { record = {} } = {}) {
  const field = accessClassificationField(classification, fieldId);
  if (!field || !HANDOFF_INFEASIBLE_CLASSES.includes(text(field.class))) return null;
  const lastObserved = lastObservedFromRecord(record);
  const observedLabel = handoffObservedDateLabel(lastObserved);
  const sentence = accessSentence(field);
  return {
    field: field.id,
    label: text(field.label) || text(field.id),
    class: field.class,
    sign_in_required: field.class === "authenticated",
    last_observed_at: lastObserved,
    last_observed_label: observedLabel || null,
    line: observedLabel ? `${sentence} CityScroll last observed this matter on ${observedLabel}.` : sentence,
  };
}

/**
 * Every handoff line this classification produces for one record, in the
 * classification's own field order. `fields`, when supplied, restricts the
 * output to those field ids; the order still comes from the classification so
 * a caller cannot reorder the disclosure by accident.
 */
export function buildProcurementHandoffCopy(classification, { record = {}, fields = null } = {}) {
  const wanted = Array.isArray(fields) ? new Set(fields.map((id) => text(id))) : null;
  const all = Array.isArray(classification?.fields) ? classification.fields : [];
  const notes = [];
  for (const field of all) {
    const id = text(field?.id);
    if (!id || (wanted && !wanted.has(id))) continue;
    const note = handoffCopyForField(classification, id, { record });
    if (note) notes.push(note);
  }
  return {
    schema: PROCUREMENT_HANDOFF_COPY_SCHEMA,
    observation_vintage: classification?.observation_vintage || null,
    last_observed_at: lastObservedFromRecord(record),
    notes,
  };
}

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render the handoff notes as a short list beneath an existing official-source
 * handoff. Returns "" when there is nothing to disclose, so a caller can
 * splice it unconditionally without inventing an empty section.
 */
export function renderProcurementHandoffCopyHtml(copy) {
  const notes = Array.isArray(copy?.notes) ? copy.notes : [];
  if (!notes.length) return "";
  const items = notes
    .map((note) => `<li class="procurement-handoff-note" data-access-class="${esc(note.class)}">${esc(note.line)}</li>`)
    .join("");
  return `<ul class="procurement-handoff-copy">${items}</ul>`;
}
