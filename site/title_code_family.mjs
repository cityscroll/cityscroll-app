/**
 * Build the exact-code family index used by static exam documents.
 *
 * Exact publisher codes identify the civil-service job title; inferred family
 * values keep their quiet marker so readers can distinguish a derived grouping.
 */

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
export function titleCodeFamilyView(exam = {}) {
  const code = clean(exam.title_code);
  if (code) return { code, confidence: "publisher", label: "Publisher-issued title code", marker: null };
  const inferred = clean(exam.title_code_family);
  if (inferred) return { code: inferred, confidence: "inferred", label: "Likely title family", marker: "quiet" };
  return null;
}

export function buildTitleCodeFamilyIndex(exams = []) {
  const index = {};
  for (const exam of Array.isArray(exams) ? exams : []) {
    const family = titleCodeFamilyView(exam);
    const examNumber = clean(exam?.exam_number);
    if (!family || !/^\d{4}$/.test(examNumber)) continue;
    const members = index[family.code] || [];
    members.push({
      exam_number: examNumber,
      title: clean(exam.title) || `Exam ${examNumber}`,
    });
    index[family.code] = members;
  }
  for (const members of Object.values(index)) {
    members.sort((left, right) => left.exam_number.localeCompare(right.exam_number));
  }
  return index;
}
