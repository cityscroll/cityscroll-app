/**
 * T2 attachment structured tables — notice-detail UI helpers.
 *
 * Loaded only when a notice carries extracted_tables (dynamic import from
 * alerts fillContext). Keep off the home cold path so wireBytes budgets stay
 * honest; tables JSON itself is already notice-scoped via attachment-metadata.
 */

function defaultEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tableCellHTML(value, esc) {
  return `<td style="border:1px solid var(--line,#d0d4dc);padding:6px 8px;vertical-align:top">${esc(String(value ?? ""))}</td>`;
}

function oneTableHTML(table, tableIndex, { t, esc }) {
  const headers = Array.isArray(table?.headers) ? table.headers : []; // source: runtime accumulator (not a published dataset)
  const rows = Array.isArray(table?.rows) ? table.rows : []; // source: runtime accumulator (not a published dataset)
  if (!headers.length && !rows.length) return "";
  const head = headers.length
    ? `<thead><tr>${headers.map((h, i) => `<th scope="col" data-col="${i}" tabindex="0" role="columnheader" style="border:1px solid var(--line,#d0d4dc);padding:6px 8px;background:var(--panel-2,#f4f5f7);text-align:left;cursor:pointer;user-select:none">${esc(String(h ?? ""))}</th>`).join("")}</tr></thead>`
    : "";
  const body = rows.map((row) => {
    const cells = Array.isArray(row) ? row : []; // source: runtime accumulator (not a published dataset)
    return `<tr>${(headers.length ? headers : cells).map((_, i) => tableCellHTML(cells[i] ?? "", esc)).join("")}</tr>`;
  }).join("");
  const caption = table?.caption
    ? `<caption style="caption-side:top;text-align:left;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--muted);padding:0 0 6px">${esc(table.caption)}</caption>`
    : (headers.length
      ? `<caption style="caption-side:top;text-align:left;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--muted);padding:0 0 6px">${esc(t("notice_attachment_table_caption", { n: tableIndex + 1 }))}</caption>`
      : "");
  // Real HTML table; th click sorts client-side (cheap; no library).
  return `<table class="attachment-table" data-table-index="${tableIndex}" style="width:100%;border-collapse:collapse;font:12px/1.45 ui-sans-serif,system-ui,sans-serif;margin:0 0 12px">
    ${caption}${head}<tbody>${body}</tbody>
  </table>`;
}

/**
 * Progressive-disclosure block for one attachment's extracted tables.
 * @param {object} attachment
 * @param {{ t?: Function, esc?: Function }} opts
 */
export function attachmentTablesHTML(attachment, opts = {}) {
  const tables = Array.isArray(attachment?.extracted_tables) ? attachment.extracted_tables : []; // source: runtime accumulator (not a published dataset)
  if (!tables.length || (attachment.tables_status && attachment.tables_status !== "ok")) return "";
  const t = typeof opts.t === "function" ? opts.t : (k) => k;
  const esc = typeof opts.esc === "function" ? opts.esc : defaultEsc;
  const preview = String(attachment.tables_preview || `${tables.length} table${tables.length === 1 ? "" : "s"}`).trim();
  const previewShort = preview.length > 280 ? `${preview.slice(0, 277).trimEnd()}…` : preview;
  const body = tables.map((table, i) => oneTableHTML(table, i, { t, esc })).filter(Boolean).join("");
  if (!body) return "";
  return `<details class="attachment-tables inline-disclose attachment-extract" style="margin:6px 0 2px">
    <summary class="attachment-tables-summary attachment-extract-summary" style="font:12px/1.55 ui-sans-serif,system-ui,sans-serif;color:var(--muted);cursor:pointer">
      <span class="attachment-tables-label">${esc(t("notice_attachment_tables_summary"))}</span>
      <span class="attachment-tables-preview attachment-extract-preview" lang="en" dir="ltr" style="display:block;margin-top:2px;color:var(--ink)">“${esc(previewShort)}”</span>
    </summary>
    <div class="attachment-tables-body inline-disclose-body scope" lang="en" dir="ltr" style="margin-top:8px;max-height:28rem;overflow:auto">${body}</div>
  </details>`;
}

/** Click/keyboard sort on th[data-col] within a root. */
export function bindAttachmentTableSort(root) {
  if (!root) return;
  root.querySelectorAll("table.attachment-table").forEach((table) => {
    const heads = table.querySelectorAll("th[data-col]");
    heads.forEach((th) => {
      const sortCol = () => {
        const col = Number(th.getAttribute("data-col"));
        const tbody = table.tBodies[0];
        if (!tbody || !Number.isInteger(col)) return;
        const dir = th.getAttribute("data-sort-dir") === "asc" ? "desc" : "asc";
        heads.forEach((other) => other.removeAttribute("data-sort-dir"));
        th.setAttribute("data-sort-dir", dir);
        const rows = [...tbody.rows];
        rows.sort((a, b) => {
          const av = (a.cells[col]?.textContent || "").trim();
          const bv = (b.cells[col]?.textContent || "").trim();
          const an = Number(av.replace(/[%,$]/g, ""));
          const bn = Number(bv.replace(/[%,$]/g, ""));
          let cmp = 0;
          if (Number.isFinite(an) && Number.isFinite(bn) && av !== "" && bv !== "") cmp = an - bn;
          else cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
          return dir === "asc" ? cmp : -cmp;
        });
        rows.forEach((row) => tbody.appendChild(row));
      };
      th.addEventListener("click", sortCol);
      th.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          sortCol();
        }
      });
    });
  });
}

/** True when progressive table disclosure should mount. */
export function attachmentHasTables(attachment) {
  const tables = Array.isArray(attachment?.extracted_tables) ? attachment.extracted_tables : []; // source: runtime accumulator (not a published dataset)
  return tables.length > 0 && (!attachment.tables_status || attachment.tables_status === "ok");
}
