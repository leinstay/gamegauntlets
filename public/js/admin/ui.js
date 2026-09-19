// admin/ui.js — small helpers shared by every admin/*.js tab module. Kept separate from the main
// site's ../ui.js (whose components are wheel/settings-page specific) rather than exported from
// there, to avoid widening that file's surface for an admin-only need.

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** `null`/`undefined` -> "-"; anything else -> the browser's local date+time rendering. */
export function fmtDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/** Render a dismissable error banner into `el` (replacing any previous content). */
export function showError(el, message) {
  el.innerHTML = `<div class="admin-error">${escapeHtml(message)}</div>`;
}

/** Pretty-print a JSON value (e.g. a conflict's `candidates` column) for display. */
export function fmtJson(value) {
  try {
    return escapeHtml(JSON.stringify(value, null, 2));
  } catch {
    return escapeHtml(String(value));
  }
}
