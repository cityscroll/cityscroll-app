/**
 * Exam browse reader-copy localization: no mid-sentence language switches.
 *
 *   node --test test/exam_reader_copy.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyExamQualificationCategory,
  examQualificationCopy,
  examQualificationLineHTML,
  examFeeWaiverCopy,
  examResidencyCopy,
  examTestMethodCopy,
  translationAvailable,
  EXAM_QUAL_EN,
} from "../site/exam_reader_copy.mjs";

const artifact = JSON.parse(
  readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)),
);

const EN = {
  career_diff_quals: "Who may qualify",
  career_qualifications: "Who may qualify:",
  career_qual_bachelors: EXAM_QUAL_EN.bachelors,
  career_qual_associates: EXAM_QUAL_EN.associates,
  career_qual_masters: EXAM_QUAL_EN.masters,
  career_qual_high_school: EXAM_QUAL_EN.high_school,
  career_qual_high_school_plus: EXAM_QUAL_EN.high_school_plus,
  career_qual_education_and_experience: EXAM_QUAL_EN.education_and_experience,
  career_qual_experience: EXAM_QUAL_EN.experience,
  career_qual_no_prior_experience: EXAM_QUAL_EN.no_prior_experience,
  career_qual_city_employees: EXAM_QUAL_EN.city_employees,
  career_qual_see_official_noe: EXAM_QUAL_EN.see_official_noe,
  career_fee_waiver_boilerplate:
    "Fee waivers may apply for veterans, unemployed applicants, students, first-time test takers, and public-assistance recipients.",
  career_fee_none_charged: "No application fee is charged for this exam.",
  career_residency_not_required: "City residency is not required for this position.",
  career_residency_may_be_required: "City residency may be required — see the official NOE.",
  career_diff_format_eee: "Education and experience review",
  career_diff_format_mc: "Multiple-choice test",
  career_diff_format_other: "See NOE for test format",
  career_noe_posted: "NOE posted",
};

const ES = {
  ...EN,
  career_diff_quals: "Quién puede calificar",
  career_qualifications: "¿Quién puede calificar?",
  career_qual_bachelors: "Un título de licenciatura de un colegio o universidad acreditados.",
  career_qual_associates: "Un título de asociado de un colegio o universidad acreditados.",
  career_qual_masters: "Un título de maestría de un colegio o universidad acreditados.",
  career_qual_high_school: "Un diploma de escuela secundaria o equivalente.",
  career_qual_high_school_plus:
    "Un diploma de escuela secundaria o equivalente, más los requisitos de licencia, médicos o de evaluación del NOE.",
  career_qual_education_and_experience:
    "Se aplican requisitos de educación y experiencia: consulte el NOE oficial para cada vía.",
  career_qual_experience:
    "Se requiere experiencia laboral previa: consulte el NOE oficial para los detalles.",
  career_qual_no_prior_experience: "No se requiere experiencia previa.",
  career_qual_city_employees: "Solo para empleados elegibles de la Ciudad: consulte el NOE oficial.",
  career_qual_see_official_noe:
    "Consulte el Aviso oficial de examen (NOE) para saber quién puede calificar.",
  career_fee_waiver_boilerplate:
    "Pueden aplicarse exenciones de tarifa para veteranos, solicitantes desempleados, estudiantes, quienes rinden por primera vez y personas con asistencia pública.",
  career_fee_none_charged: "Este examen no tiene tarifa de solicitud.",
  career_residency_not_required: "No se requiere residencia en la Ciudad para este puesto.",
  career_residency_may_be_required: "Puede requerirse residencia en la Ciudad: consulte el NOE oficial.",
  career_diff_format_eee: "Revisión de educación y experiencia",
  career_diff_format_mc: "Examen de opción múltiple",
  career_diff_format_other: "Consulte el NOE para el formato del examen",
  career_noe_posted: "NOE publicado",
};

const FR = {
  ...EN,
  career_diff_quals: "Qui peut se qualifier",
  career_qualifications: "Qui peut être admissible :",
  career_qual_bachelors: "Un diplôme de licence d'un collège ou d'une université accrédité.",
  career_qual_associates: "Un diplôme d'associé d'un collège ou d'une université accrédité.",
  career_qual_masters: "Un diplôme de master d'un collège ou d'une université accrédité.",
  career_qual_high_school: "Un diplôme d'études secondaires ou l'équivalent.",
  career_qual_high_school_plus:
    "Un diplôme d'études secondaires ou l'équivalent, plus les exigences de permis, médicales ou de sélection du NOE.",
  career_qual_education_and_experience:
    "Des exigences d'études et d'expérience s'appliquent — consultez le NOE officiel pour chaque parcours.",
  career_qual_experience:
    "Une expérience professionnelle préalable est requise — consultez le NOE officiel pour les détails.",
  career_qual_no_prior_experience: "Aucune expérience préalable n'est requise.",
  career_qual_city_employees: "Réservé aux employés admissibles de la Ville — consultez le NOE officiel.",
  career_qual_see_official_noe:
    "Consultez l'avis officiel d'examen (NOE) pour savoir qui peut se qualifier.",
  career_fee_waiver_boilerplate:
    "Des exonérations de frais peuvent s'appliquer aux vétérans, chômeurs, étudiants, candidats pour la première fois et bénéficiaires d'aide publique.",
  career_fee_none_charged: "Aucun frais de candidature n'est exigé pour cet examen.",
  career_residency_not_required: "La résidence dans la Ville n'est pas requise pour ce poste.",
  career_residency_may_be_required: "La résidence dans la Ville peut être requise — consultez le NOE officiel.",
  career_diff_format_eee: "Examen sur dossier (études et expérience)",
  career_diff_format_mc: "Examen à choix multiples",
  career_diff_format_other: "Voir le NOE pour le format de l'examen",
  career_noe_posted: "NOE publié",
};

function dictT(dict) {
  return (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key);
}

function examByNumber(id) {
  return artifact.exams.find((row) => String(row.exam_number) === String(id));
}

const KNOWN_EN_PROSE = [
  "A bachelor's degree from an accredited college or university.",
  "A baccalaureate degree from an accredited college or university",
  "Two years of automotive maintenance experience",
  "A high school diploma or equivalent",
  "Prior work experience is required",
];

test("1 lang=es does not emit known normalized English eligibility prose", () => {
  const cases = [
    examByNumber("7016"), // Caseworker — bachelor's
    examByNumber("7013"), // Automotive — experience
    examByNumber("7331"), // Traffic — HS + requirements
    examByNumber("7006"), // Assistant Civil Engineer — edu+exp paths
    {
      exam_number: "9999",
      title: "Synthetic no-experience",
      qualifications: null,
      no_experience_required: true,
      eligibility: "open_competitive",
    },
    {
      exam_number: "9998",
      title: "Synthetic promotion",
      qualifications: null,
      eligibility: "promotion",
    },
  ].filter(Boolean);

  assert.ok(cases.length >= 5, "need several eligibility patterns");
  const t = dictT(ES);
  for (const exam of cases) {
    const copy = examQualificationCopy(exam, { lang: "es", t });
    assert.ok(copy?.text, `expected Spanish copy for ${exam.exam_number}`);
    for (const en of KNOWN_EN_PROSE) {
      assert.equal(
        copy.text.includes(en.slice(0, 24)),
        false,
        `${exam.exam_number} leaked English fragment under lang=es: ${copy.text}`,
      );
    }
    assert.match(copy.text, /[áéíóúñüÁÉÍÓÚÑÜ]|licenciatura|diploma|experiencia|empleados|Consulte|requiere/i);
  }
});

test("2 labels and values use the same selected language", () => {
  const exam = examByNumber("7016");
  const tEs = dictT(ES);
  const htmlEs = examQualificationLineHTML(exam, {
    lang: "es",
    t: tEs,
    esc: (s) => String(s),
    labelKey: "career_diff_quals",
  });
  assert.match(htmlEs, /Quién puede calificar/);
  assert.match(htmlEs, /licenciatura/);
  assert.equal(/bachelor|baccalaureate/i.test(htmlEs), false);
  assert.equal(/lang="en"/i.test(htmlEs), false);

  const tFr = dictT(FR);
  const htmlFr = examQualificationLineHTML(exam, {
    lang: "fr",
    t: tFr,
    esc: (s) => String(s),
  });
  assert.match(htmlFr, /Qui peut se qualifier/);
  assert.match(htmlFr, /licence|diplôme/i);
  assert.equal(/bachelor|baccalaureate/i.test(htmlFr), false);
});

test("3 English unchanged under lang=en", () => {
  const exam = examByNumber("7016");
  const copy = examQualificationCopy(exam, { lang: "en", t: dictT(EN) });
  assert.equal(copy.source, "en_source");
  assert.equal(copy.text, exam.qualifications);
  const html = examQualificationLineHTML(exam, {
    lang: "en",
    t: dictT(EN),
    esc: (s) => String(s),
  });
  assert.match(html, /lang="en"/);
  assert.match(html, /bachelor's degree/i);
});

test("4 missing translations fail gracefully (no mixed-language sentences)", () => {
  // Spanish labels, but qualification value keys intentionally missing → English fallback blocked.
  const partial = {
    career_diff_quals: "Quién puede calificar",
    career_qual_see_official_noe:
      "Consulte el Aviso oficial de examen (NOE) para saber quién puede calificar.",
    // deliberately omit career_qual_bachelors
  };
  const t = dictT(partial);
  assert.equal(
    translationAvailable(t, "es", "career_qual_bachelors", EXAM_QUAL_EN.bachelors),
    false,
  );
  const exam = {
    exam_number: "7016",
    qualifications: "A bachelor's degree from an accredited college or university.",
    education_level: "bachelors",
    no_experience_required: true,
  };
  const copy = examQualificationCopy(exam, { lang: "es", t });
  assert.ok(copy);
  assert.equal(copy.source, "fail_safe");
  assert.equal(copy.text.includes("bachelor"), false);
  assert.match(copy.text, /Consulte el Aviso oficial/);

  const html = examQualificationLineHTML(exam, { lang: "es", t, esc: (s) => String(s) });
  assert.match(html, /Quién puede calificar/);
  assert.equal(/bachelor|A bachelor/i.test(html), false);

  // If even the fail-safe key is missing, omit the line rather than hybridize.
  const bare = dictT({ career_diff_quals: "Quién puede calificar" });
  const omitted = examQualificationCopy(exam, { lang: "es", t: bare });
  assert.equal(omitted, null);
  assert.equal(examQualificationLineHTML(exam, { lang: "es", t: bare, esc: (s) => String(s) }), "");
});

test("5 official source links still point to the original NOE", () => {
  const exam = examByNumber("7016");
  assert.ok(exam.notice_url);
  assert.match(exam.notice_url, /^https:\/\/www\.nyc\.gov\/assets\/dcas\/downloads\/pdf\/noes\//);
  // Localized card copy must not rewrite the official NOE URL.
  const copy = examQualificationCopy(exam, { lang: "es", t: dictT(ES) });
  assert.ok(copy?.text);
  assert.equal(exam.notice_url, ACCEPTANCE_NOE_7016);
});

const ACCEPTANCE_NOE_7016 = "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277016000.pdf";

test("classification covers bachelor, experience, edu+exp, HS+, no-exp, promotion", () => {
  assert.equal(classifyExamQualificationCategory(examByNumber("7016")), "bachelors");
  assert.equal(classifyExamQualificationCategory(examByNumber("7013")), "education_and_experience");
  assert.equal(classifyExamQualificationCategory(examByNumber("7006")), "education_and_experience");
  assert.equal(classifyExamQualificationCategory(examByNumber("7331")), "high_school_plus");
  assert.equal(
    classifyExamQualificationCategory({ no_experience_required: true }),
    "no_prior_experience",
  );
  assert.equal(
    classifyExamQualificationCategory({ eligibility: "promotion" }),
    "city_employees",
  );
});

test("fee waiver near-boilerplate and residency localize without English leakage", () => {
  const exam = examByNumber("7016");
  const fee = examFeeWaiverCopy(exam, { lang: "es", t: dictT(ES) });
  assert.ok(fee);
  assert.equal(fee.source, "localized");
  assert.match(fee.text, /exenciones|veteranos/i);
  assert.equal(/Veterans, unemployed/i.test(fee.text), false);

  const residency = examResidencyCopy(exam, { lang: "es", t: dictT(ES) });
  assert.ok(residency);
  assert.match(residency.text, /residencia/i);
  assert.equal(/City residency is not required/i.test(residency.text), false);
});

test("test method prefers localized exam_format under lang=fr", () => {
  const exam = examByNumber("7016");
  const copy = examTestMethodCopy(exam, {
    lang: "fr",
    t: dictT(FR),
    formatLabel: () => FR.career_diff_format_eee,
  });
  assert.equal(copy.source, "localized");
  assert.equal(copy.text, FR.career_diff_format_eee);
  assert.equal(/Education and experience exam/i.test(copy.text), false);
});

test("exams browse renderer imports the shared reader-copy projection", () => {
  const source = readFileSync(new URL("../site/app/exams.mjs", import.meta.url), "utf8");
  assert.match(source, /exam_reader_copy\.mjs/);
  assert.match(source, /examQualificationLineHTML|examQualificationCopy/);
  assert.match(source, /examFeeWaiverCopy/);
  // Must not keep the hybrid raw-English pattern under the translated label.
  assert.equal(
    /career-diff-quals" lang="en"[^>]*>\$\{t\("career_diff_quals"\)\}[^<]*\$\{escUiHtml\(exam\.qualifications\)\}/.test(source),
    false,
  );
});
