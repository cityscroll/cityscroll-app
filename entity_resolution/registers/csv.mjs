// RFC 4180 CSV reader, node built-ins only. Quoted fields, doubled quotes, CRLF/LF, embedded
// newlines. Rows are arrays; parseCsvRecords pairs them with the header and FLAGS ragged rows
// (wrong field count) instead of dropping them.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  if (n && text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** -> { header, records: [{ values: {col: string}, line, field_count, ragged }] } */
export function parseCsvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0];
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === "") continue; // blank line
    const values = {};
    for (let c = 0; c < header.length; c++) values[header[c]] = cells[c] ?? "";
    const extra = cells.length > header.length ? cells.slice(header.length) : [];
    records.push({ values, row_index: r, field_count: cells.length, ragged: cells.length !== header.length, extra_cells: extra });
  }
  return { header, records };
}
