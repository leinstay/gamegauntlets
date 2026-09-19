// api.js — fetch wrapper for the /api/* backend (see docs/specs "API contract").
//
// - GET /api/session is fetched once and cached; every POST sends its csrf
//   token back in the X-CSRF-Token header, same-origin credentials only.
// - When the page URL has ?mock=1, every call is routed to mock-api.js
//   instead, so the whole UI can be exercised without a running backend.

import * as mock from "./mock-api.js";

const MOCK = new URLSearchParams(location.search).get("mock") === "1";

let sessionPromise = null;

function fetchSession() {
  if (!sessionPromise) {
    sessionPromise = MOCK
      ? mock.getSession()
      : fetch("/api/session", { credentials: "same-origin" })
          .then((res) => {
            if (!res.ok) throw new Error(`GET /api/session failed: ${res.status}`);
            return res.json();
          })
          .catch((err) => {
            sessionPromise = null; // allow a retry on the next call
            throw err;
          });
  }
  return sessionPromise;
}

// Methods that mutate state: same set the backend's CSRF/same-origin check applies to
// (STATE_CHANGING_METHODS in src/api.js) minus GET, which never carries a body here.
const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

async function request(method, path, body, { retryOn403 = true } = {}) {
  if (MOCK) return mock.request(method, path, body);

  const opts = { method, credentials: "same-origin", headers: {} };

  if (WRITE_METHODS.has(method)) {
    const session = await fetchSession();
    opts.headers["X-CSRF-Token"] = session.csrf;
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body ?? {});
  }

  const res = await fetch(path, opts);

  // A 403 on a write means either the CSRF token or same-origin check failed (see src/api.js's
  // onRequest hook). The origin check can't be fixed client-side, but a stale csrf (e.g. the session
  // cookie was rotated by a login/logout in another tab since we cached it) can: drop the cached
  // session so the next fetchSession() re-reads the real cookie, and retry exactly once.
  if (res.status === 403 && WRITE_METHODS.has(method) && retryOn403) {
    sessionPromise = null;
    return request(method, path, body, { retryOn403: false });
  }

  if (!res.ok) {
    const err = new Error(`${method} ${path} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/csv")) return res.blob();
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  session: fetchSession,
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  del: (path) => request("DELETE", path),
  isMock: () => MOCK,
};

// Convenience wrappers matching the plan's API contract 1:1.
export const getStats = () => api.get("/api/stats");
export const getDictionary = (field, lang) =>
  api.get(`/api/dictionaries/${field}?lang=${encodeURIComponent(lang)}`);
export const searchGames = (q, lang) =>
  api.get(`/api/games/search?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}`);
export const getGame = (id, lang) => api.get(`/api/games/${id}?lang=${encodeURIComponent(lang)}`);
export const postWheel = (payload) => api.post("/api/wheel", payload);
export const postWheelRandom = (payload) => api.post("/api/wheel/random", payload);
export const postWheelMarbles = (payload) => api.post("/api/wheel/marbles", payload);
export const logout = () => api.post("/api/auth/logout");
export const loginUrl = "/api/auth/steam";
