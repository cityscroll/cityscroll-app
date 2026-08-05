// Glossary-pinned informal translation of City Record notice prose.
//
// The model must keep dates, amounts, PINs, Request IDs, agency names, and addresses
// byte-for-byte identical to the source. Callers run checkInvariants() and refuse to
// display or cache any translation that fails.

import {
  checkInvariants,
  noticeMeta,
  noticeSourceText,
} from "./translate_invariants.mjs";

export const TRANSLATE_LANGS = Object.freeze([
  "es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur",
]);

const MODEL = "claude-haiku-4-5";
const MAX_SOURCE_CHARS = 6000;
const TRANSLATION_TOOL_NAME = "return_translation";

const TRANSLATION_TOOL = Object.freeze({
  name: TRANSLATION_TOOL_NAME,
  description: "Return the translated City Record notice fields.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
    },
    required: ["title", "description"],
    additionalProperties: false,
  },
});

// Language labels for the system prompt (native name where helpful).
const LANG_LABEL = {
  es: "Spanish",
  "zh-Hans": "Simplified Chinese",
  ru: "Russian",
  bn: "Bengali",
  ht: "Haitian Creole",
  ko: "Korean",
  fr: "French",
  pl: "Polish",
  ar: "Arabic",
  ur: "Urdu",
};

// Hard-pinned civic terms + NYC agency acronyms. The CPC→"Chinese Communist Party"
// failure mode is why agency acronyms are listed with their correct expansion and the
// instruction to leave the English name untouched in the translation.
const GLOSSARY_PINS = {
  es: {
    RFP: "Solicitud de Propuestas (RFP)",
    Award: "adjudicación",
    Procurement: "Adquisiciones",
    PIN: "PIN",
  },
  "zh-Hans": {
    RFP: "征求建议书 (RFP)",
    Award: "中标（授予合同）",
    Procurement: "采购",
    PIN: "PIN",
  },
  ru: {
    RFP: "Запрос предложений (RFP)",
    Award: "присуждение контракта",
    Procurement: "Закупки",
    PIN: "PIN",
  },
  bn: {
    RFP: "প্রস্তাবের অনুরোধ (RFP)",
    Award: "প্রদান",
    Procurement: "ক্রয়",
    PIN: "PIN",
  },
  ht: {
    RFP: "Demann Pwopozisyon (RFP)",
    Award: "akòdman",
    Procurement: "Akizisyon",
    PIN: "PIN",
  },
  ko: {
    RFP: "제안요청서 (RFP)",
    Award: "낙찰",
    Procurement: "조달",
    PIN: "PIN",
  },
  fr: {
    RFP: "Demande de propositions (RFP)",
    Award: "attribution",
    Procurement: "Approvisionnement",
    PIN: "PIN",
  },
  pl: {
    RFP: "Zapytanie ofertowe (RFP)",
    Award: "przyznanie",
    Procurement: "Zamówienia",
    PIN: "PIN",
  },
  ar: {
    RFP: "طلب تقديم عروض (RFP)",
    Award: "ترسية",
    Procurement: "المشتريات",
    PIN: "PIN",
  },
  ur: {
    RFP: "درخواستِ تجاویز (RFP)",
    Award: "ایوارڈ",
    Procurement: "خریداری",
    PIN: "PIN",
  },
};

const AGENCY_ACRONYM_PINS = [
  "CPC = City Planning Commission (never 'Chinese Communist Party')",
  "DHS = Department of Homeless Services (never 'Department of Homeland Security')",
  "HPD = Housing Preservation and Development",
  "DOT = Department of Transportation",
  "DEP = Department of Environmental Protection",
  "DCAS = Department of Citywide Administrative Services",
  "DOE = Department of Education",
  "DOHMH = Department of Health and Mental Hygiene",
  "MOCS = Mayor's Office of Contract Services",
  "NYCHA = New York City Housing Authority",
  "SBS = Department of Small Business Services",
  "DDC = Department of Design and Construction",
];

export function isTranslateLang(lang) {
  return TRANSLATE_LANGS.includes(lang);
}

export async function sourceHash(text) {
  const data = new TextEncoder().encode(String(text || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildSystem(lang, meta) {
  const pins = GLOSSARY_PINS[lang] || {};
  const pinLines = Object.entries(pins).map(([k, v]) => `- ${k} → ${v}`).join("\n");
  const agency = meta.agency_name ? `Agency name (keep EXACTLY): ${meta.agency_name}` : "";
  const pin = meta.pin ? `PIN (keep EXACTLY): ${meta.pin}` : "";
  const rid = meta.request_id ? `Request ID (keep EXACTLY): ${meta.request_id}` : "";
  return [
    `You produce an INFORMAL translation of a New York City Record notice into ${LANG_LABEL[lang] || lang}.`,
    "This is an unofficial aid only — the English original remains the legal record.",
    `Call ${TRANSLATION_TOOL_NAME} exactly once with the translated title and description.`,
    "",
    "HARD RULES — if you cannot satisfy them, leave the English tokens intact in the tool input:",
    "1. Every dollar amount ($…), date, PIN, Request ID, multi-digit number, agency name, and street address from the source MUST appear character-for-character in the output.",
    "2. Do NOT convert currencies, reformat dates, localize numbers, or translate proper names of agencies, streets, boroughs, or PINs.",
    "3. Leave English acronyms for NYC agencies as-is; do not expand them into a wrong agency.",
    "",
    "Glossary pins (use these renderings for the civic terms; keep the English acronym visible):",
    pinLines || "(none)",
    "",
    "Agency acronym pins:",
    ...AGENCY_ACRONYM_PINS.map((line) => `- ${line}`),
    "",
    agency,
    pin,
    rid,
  ].filter(Boolean).join("\n");
}

function translationFieldsFromMessage(data) {
  const block = (data?.content || []).find(
    (candidate) => candidate?.type === "tool_use"
      && candidate.name === TRANSLATION_TOOL_NAME,
  );
  if (!block?.input || typeof block.input !== "object" || Array.isArray(block.input)) {
    return null;
  }
  if (typeof block.input.title !== "string" || typeof block.input.description !== "string") {
    return null;
  }
  return {
    title: block.input.title,
    description: block.input.description,
  };
}

/**
 * Call Anthropic Haiku for an informal title+description translation.
 * Returns { title, description, model } or { degraded, reason }.
 * Does NOT check invariants — callers must.
 */
export async function translateNoticeFields(env, lang, row) {
  if (!isTranslateLang(lang)) return { degraded: true, reason: "bad-lang" };
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return { degraded: true, reason: "no-key" };

  const meta = noticeMeta(row);
  const title = String(row.short_title || "").trim();
  const description = String(
    row.description || row.additional_description_1 || row.other_info || row.other_info_1 || "",
  ).trim().slice(0, MAX_SOURCE_CHARS);
  if (!title && !description) return { degraded: true, reason: "empty" };

  const userPayload = JSON.stringify({
    title,
    description,
    request_id: meta.request_id,
    pin: meta.pin,
    agency_name: meta.agency_name,
    contract_amount: meta.contract_amount,
    due_date: meta.due_date,
    start_date: meta.start_date,
    address: meta.address,
  });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1800,
        system: buildSystem(lang, meta),
        tools: [TRANSLATION_TOOL],
        tool_choice: { type: "tool", name: TRANSLATION_TOOL_NAME },
        messages: [
          {
            role: "user",
            content:
              "Translate the following City Record notice fields into the target language. "
              + "Preserve every amount, date, PIN, Request ID, agency name, and address exactly.\n\n"
              + userPayload,
          },
        ],
      }),
    });
    if (!r.ok) return { degraded: true, reason: `api-${r.status}` };
    const data = await r.json();
    const parsed = translationFieldsFromMessage(data);
    if (!parsed) return { degraded: true, reason: "no-tool" };
    return { title: parsed.title, description: parsed.description, model: MODEL };
  } catch (e) {
    return { degraded: true, reason: "error", message: String(e?.message || e) };
  }
}

/**
 * Translate + invariant-check a notice row. Returns a cacheable payload or a degraded result.
 * On invariant failure, ok is false and the payload must not be cached or shown.
 */
export async function translateAndVerify(env, lang, row) {
  const source = noticeSourceText(row);
  const meta = noticeMeta(row);
  const hash = await sourceHash(source);
  const result = await translateNoticeFields(env, lang, row);
  if (result.degraded) {
    return { ok: false, reason: result.reason, source_hash: hash };
  }

  // Check against the combined translated title+description PLUS the pinned meta tokens
  // the prompt was told to echo (PIN, request id, agency) — models sometimes put them
  // only in description, so we also accept them if present in either field. We append
  // the structured tokens the UI always has from the original, so a model that correctly
  // kept amounts/dates in prose but omitted restating the PIN still passes when those
  // tokens appear in the translation body.
  const translatedBlob = [result.title, result.description].filter(Boolean).join("\n");
  const check = checkInvariants(source, translatedBlob, meta);
  if (!check.ok) {
    return {
      ok: false,
      reason: "invariant-mismatch",
      missing: check.missing,
      source_hash: hash,
    };
  }

  return {
    ok: true,
    source_hash: hash,
    title: result.title,
    description: result.description,
    model: result.model,
    lang,
    request_id: meta.request_id,
  };
}
