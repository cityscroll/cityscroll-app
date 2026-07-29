// Shared, pure NYC location primitives for the static site and Worker. Lens-specific modules decide which text is
// scope evidence; this module only normalizes and extracts the evidence they provide.

export const BOROUGHS = [
  ["Manhattan", /\b(?:manhattan|new york county)\b/i],
  ["Bronx", /\b(?:the bronx|bronx county|bronx)\b/i],
  ["Brooklyn", /\b(?:brooklyn|kings county)\b/i],
  ["Queens", /\b(?:queens|queens county)\b/i],
  ["Staten Island", /\b(?:staten island|richmond county)\b/i],
];

export const ADDRESS_RE = /\b\d{1,5}(?:-\d{1,5})?(?!\s*(?:feet|foot|ft\.?|square|sf)\b)\s+[A-Z0-9][A-Z0-9.'’ -]{1,60}?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway)\b/gi;

const APPLICATION_BOROUGHS = {
  M: "Manhattan",
  X: "Bronx",
  K: "Brooklyn",
  Q: "Queens",
  R: "Staten Island",
};
const BOARD_BOROUGHS = {
  M: "Manhattan",
  BX: "Bronx",
  BK: "Brooklyn",
  Q: "Queens",
  SI: "Staten Island",
};
const BBL_BOROUGH_CODES = {
  Manhattan: "1",
  Bronx: "2",
  Brooklyn: "3",
  Queens: "4",
  "Staten Island": "5",
};

export function plainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x?[0-9a-f]+;/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

export function normalizeAddress(value) {
  return plainText(value)
    .replace(/\s*,\s*/g, ", ")
    .replace(/[.,;:\s]+$/, "")
    .trim();
}

export function boroughsIn(text) {
  return BOROUGHS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function canonicalBorough(value) {
  return BOROUGHS.find(([, pattern]) => pattern.test(value))?.[0] || plainText(value);
}

export function applicationSignals(text) {
  const numbers = [];
  const boroughs = [];
  const patterns = [
    /\b(?:C|N)?\s*\d{6}\s*(?:ZM|ZR|ZS|ZA|ZC|MM|HA|LD|PC|PP)([MXKQR])\b/gi,
    /\b(?:ZM|ZR|ZS|ZA|ZC|MM|HA|LD|PC|PP)\s*\d{6}\s*(?:ZM|ZR|ZS|ZA|ZC|MM|HA|LD|PC|PP)?([MXKQR])\b/gi,
    /\b\d{2}[A-Z]{3}\d{3}([MXKQR])\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      numbers.push(plainText(match[0]).replace(/\s+/g, ""));
      boroughs.push(APPLICATION_BOROUGHS[match[1].toUpperCase()]);
    }
  }
  return { numbers: unique(numbers), boroughs: unique(boroughs) };
}

export function communityBoardSignals(text) {
  const boards = [];
  const boroughs = [];
  for (const match of text.matchAll(/\bcommunity board\s*#?\s*(\d{1,2})\s*(BX|BK|SI|M|Q)\b/gi)) {
    const borough = BOARD_BOROUGHS[match[2].toUpperCase()];
    boards.push(`Community Board ${Number(match[1])}, ${borough}`);
    boroughs.push(borough);
  }
  for (const match of text.matchAll(/\bcommunity board\s+(BX|BK|SI|M|Q)\s*0?(\d{1,2})\b/gi)) {
    const borough = BOARD_BOROUGHS[match[1].toUpperCase()];
    boards.push(`Community Board ${Number(match[2])}, ${borough}`);
    boroughs.push(borough);
  }
  for (const match of text.matchAll(/\bborough of (?:the )?(Manhattan|Brooklyn|Queens|Bronx|Staten Island).{0,55}?\bcommunity board(?:\s+no\.?|\s*#)?\s*0?(\d{1,2})\b/gi)) {
    const borough = canonicalBorough(match[1]);
    boards.push(`Community Board ${Number(match[2])}, ${borough}`);
    boroughs.push(borough);
  }
  return { boards: unique(boards), boroughs: unique(boroughs) };
}

export function streetRangesIn(text) {
  const ranges = [
    ...text.matchAll(/\b([A-Z0-9][A-Za-z0-9.'’ -]{1,80}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway))\s+between\s+([A-Z0-9][A-Za-z0-9.'’ -]{1,80}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway))\s+and\s+([A-Z0-9][A-Za-z0-9.'’ -]{1,80}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway))/gi),
  ].map((match) => normalizeAddress(match[0]));
  for (const match of text.matchAll(/\bbounded by\s+(.{10,360}?)(?=;|\.\s|,\s*(?:Borough|Community District)|$)/gi)) {
    ranges.push(normalizeAddress(`bounded by ${match[1]}`));
  }
  return unique(ranges);
}

export function taxLotsIn(text) {
  return unique([...text.matchAll(/\b(?:tax\s+)?block\s*\d+[A-Z]?(?:\s*[,/&-]\s*(?:p\/o\s+|part of\s+)?lot(?:\(s\)|s)?\s*(?:\d+[A-Z]?(?:\s*(?:,|and|&|\/|-)\s*(?:p\/o\s+|part of\s+)?\d+[A-Z]?)*))?/gi)]
    .map((match) => plainText(match[0])));
}

export function bblFor(borough, block, lot) {
  const code = BBL_BOROUGH_CODES[canonicalBorough(borough)];
  const blockNumber = String(block || "").match(/\d+/)?.[0];
  const lotNumber = String(lot || "").match(/\d+/)?.[0];
  if (!code || !blockNumber || !lotNumber || blockNumber.length > 5 || lotNumber.length > 4) {
    return null;
  }
  return `${code}${blockNumber.padStart(5, "0")}${lotNumber.padStart(4, "0")}`;
}
