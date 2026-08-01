// Extract recurring lesson classes from dimension cards and append durable
// notes to engineering-lessons.md (or return proposed appends for dry-run).

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const LESSON_THRESHOLD = 2; // same lesson_class appearing ≥ N times this run

/**
 * Group cards by lesson_class and return classes that recur.
 * @param {Array<object>} cards
 * @param {number} [threshold]
 */
export function extractRecurringLessons(cards = [], threshold = LESSON_THRESHOLD) {
  const counts = new Map();
  for (const card of cards) {
    const key = card.lesson_class;
    if (!key) continue;
    if (!counts.has(key)) counts.set(key, []);
    counts.get(key).push(card);
  }
  const recurring = [];
  for (const [lessonClass, group] of counts) {
    if (group.length < threshold) continue;
    recurring.push({
      lesson_class: lessonClass,
      count: group.length,
      sample_ids: group.slice(0, 5).map((c) => c.id),
      dimensions: [...new Set(group.map((c) => c.dimension))],
      title: lessonTitle(lessonClass),
      body: lessonBody(lessonClass, group),
    });
  }
  return recurring.sort((a, b) => b.count - a.count || a.lesson_class.localeCompare(b.lesson_class));
}

function lessonTitle(lessonClass) {
  return lessonClass
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function lessonBody(lessonClass, group) {
  const surfaces = [...new Set(group.flatMap((c) => c.context || []).filter(Boolean))].slice(0, 6);
  return [
    `Recurring flywheel class \`${lessonClass}\` appeared ${group.length} times in one run.`,
    `Sample cards: ${group.slice(0, 3).map((c) => c.id).join(", ")}.`,
    surfaces.length ? `Related context: ${surfaces.join("; ")}.` : null,
    "When fixing one instance, scan siblings of the same class before closing the queue item.",
  ].filter(Boolean).join(" ");
}

/**
 * Format markdown section for a lesson (idempotent by heading anchor).
 */
export function formatLessonMarkdown(lesson, { date } = {}) {
  const day = date || "1970-01-01";
  const heading = `### ${lesson.title} (\`${lesson.lesson_class}\`)`;
  return [
    heading,
    "",
    `- **First noted:** ${day}`,
    `- **Count this run:** ${lesson.count}`,
    `- **Dimensions:** ${lesson.dimensions.join(", ")}`,
    "",
    lesson.body,
    "",
  ].join("\n");
}

/**
 * Append lessons that are not already present (by lesson_class token in file).
 * @returns {{ appended: string[], skipped: string[], text: string }}
 */
export function mergeLessonsIntoMarkdown(existingText, lessons, { date } = {}) {
  let text = existingText || defaultLessonsHeader();
  const appended = [];
  const skipped = [];
  for (const lesson of lessons) {
    const marker = `\`${lesson.lesson_class}\``;
    if (text.includes(marker)) {
      skipped.push(lesson.lesson_class);
      continue;
    }
    if (!text.endsWith("\n")) text += "\n";
    text += `\n${formatLessonMarkdown(lesson, { date })}`;
    appended.push(lesson.lesson_class);
  }
  return { appended, skipped, text };
}

export function defaultLessonsHeader() {
  return [
    "# Engineering lessons (multi-flywheel)",
    "",
    "Recurring improvement classes extracted by the multi-dimension flywheel.",
    "Append-only: runners add a section when a `lesson_class` repeats in one run.",
    "Do not hand-delete lessons; mark superseded in a new note if needed.",
    "",
    "## Lessons",
    "",
  ].join("\n");
}

/**
 * File I/O helper used by the CLI (optional).
 */
export function applyLessonsToFile(filePath, cards, { date, threshold, dryRun = false } = {}) {
  const lessons = extractRecurringLessons(cards, threshold ?? LESSON_THRESHOLD);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : defaultLessonsHeader();
  const merged = mergeLessonsIntoMarkdown(existing, lessons, { date });
  if (!dryRun && merged.appended.length) {
    writeFileSync(filePath, merged.text);
  }
  return { lessons, ...merged };
}
