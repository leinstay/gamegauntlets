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

/** `null`/`undefined`/unparsable -> `null`; otherwise how many hours ago `value` was (can be fractional). */
export function ageHours(value) {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  return Number.isFinite(ms) ? ms / (60 * 60 * 1000) : null;
}

/** `null`/`undefined`/unparsable -> ""; otherwise a short relative age, e.g. "3 h ago", "45 min ago", "2 d ago". */
export function fmtAge(value) {
  if (!value) return "";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor(Math.max(ms, 0) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
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
