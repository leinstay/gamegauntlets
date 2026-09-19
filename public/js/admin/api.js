// admin/api.js — thin wrappers around the shared fetch wrapper (../api.js) for every
// /api/admin/* endpoint (see docs/plans/2026-09-19-rewrite-plan.md, "API contract" -> Admin, and
// src/api/admin.js). Reuses the same session/CSRF handling as the rest of the site — nothing here
// talks to `fetch` directly.

import { api } from "../api.js";

function qs(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    usp.set(key, value);
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

// ---------- sources ----------
export const getSources = () => api.get("/api/admin/sources");
export const pauseSource = (name) => api.post(`/api/admin/sources/${encodeURIComponent(name)}/pause`);
export const resumeSource = (name) => api.post(`/api/admin/sources/${encodeURIComponent(name)}/resume`);
export const runSource = (name) => api.post(`/api/admin/sources/${encodeURIComponent(name)}/run`);

// ---------- conflicts ----------
export const getConflicts = ({ status, field, page } = {}) => api.get(`/api/admin/conflicts${qs({ status, field, page })}`);
export const acceptConflict = (id) => api.post(`/api/admin/conflicts/${id}/accept`);

// ---------- overrides ----------
export const createOverride = (payload) => api.post("/api/admin/overrides", payload);
export const deleteOverride = (gameId, field) => api.del(`/api/admin/overrides/${gameId}/${encodeURIComponent(field)}`);

// ---------- games ----------
export const getAdminGame = (id) => api.get(`/api/admin/games/${id}`);
export const resolveGame = (id) => api.post(`/api/admin/games/${id}/resolve`);
export const refreshGame = (id, source) => api.post(`/api/admin/games/${id}/refresh/${encodeURIComponent(source)}`);

// ---------- presets ----------
export const getPresets = () => api.get("/api/admin/presets");
export const createPreset = (payload) => api.post("/api/admin/presets", payload);
export const updatePreset = (id, payload) => api.put(`/api/admin/presets/${id}`, payload);
export const deletePreset = (id) => api.del(`/api/admin/presets/${id}`);

// ---------- users ----------
export const getUsers = ({ q, page } = {}) => api.get(`/api/admin/users${qs({ q, page })}`);
export const updateUser = (steamid, payload) => api.put(`/api/admin/users/${steamid}`, payload);

// The allow-list of override-able fields, mirrored from src/api/admin.js so the UI can build a form
// without a round-trip. Keep in sync if the backend list changes.
export const OVERRIDABLE_FIELDS = [
  "release_date",
  "release_precision",
  "name",
  "image",
  "description_en",
  "description_ru",
  "difficulty",
  "time_main",
  "time_complete",
  "score_critics",
  "gog_id",
  "steam_delisted",
];
