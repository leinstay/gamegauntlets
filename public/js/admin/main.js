// admin/main.js — boots the standalone admin panel (public/admin.html). Checks /api/session (via the
// shared ../api.js) for `user.admin`; anonymous or non-admin visitors see a "Forbidden" message and a
// login link instead of the tabs (the backend enforces the real access control — this is just so the
// panel doesn't render a confusing empty UI to someone who can't use it).

import { api, loginUrl, logout } from "../api.js";
import * as sources from "./sources.js";
import * as conflicts from "./conflicts.js";
import * as games from "./games.js";
import * as presets from "./presets.js";
import * as users from "./users.js";

const TABS = {
  sources: { label: "Sources", module: sources },
  conflicts: { label: "Conflicts", module: conflicts },
  games: { label: "Game lookup", module: games },
  presets: { label: "Presets", module: presets },
  users: { label: "Users", module: users },
};

const root = document.getElementById("admin-root");

function renderForbidden() {
  root.innerHTML = `
    <div class="admin-forbidden">
      <h1>Forbidden</h1>
      <p>You need to be logged in with an admin Steam account to use this page.</p>
      <a class="btn" href="${loginUrl}">Login with Steam</a>
    </div>
  `;
}

function renderShell(user) {
  root.innerHTML = `
    <header class="admin-header">
      <h1>Game Gauntlets — Admin</h1>
      <div class="admin-user">
        <span>${user.name || user.steamid}</span>
        <button type="button" class="btn btn-small" id="admin-logout">Logout</button>
      </div>
    </header>
    <nav class="admin-tabs" id="admin-tabs"></nav>
    <main class="admin-content" id="admin-content"></main>
  `;

  const tabsEl = document.getElementById("admin-tabs");
  const contentEl = document.getElementById("admin-content");
  let current = null;

  tabsEl.innerHTML = Object.entries(TABS)
    .map(([key, tab], i) => `<button type="button" class="admin-tab${i === 0 ? " active" : ""}" data-tab="${key}">${tab.label}</button>`)
    .join("");

  function activate(key) {
    current?.destroy?.();
    for (const btn of tabsEl.querySelectorAll(".admin-tab")) btn.classList.toggle("active", btn.dataset.tab === key);
    current = TABS[key].module.mount(contentEl);
  }

  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (btn) activate(btn.dataset.tab);
  });

  document.getElementById("admin-logout").addEventListener("click", async () => {
    await logout();
    window.location.reload();
  });

  activate(Object.keys(TABS)[0]);
}

async function boot() {
  let session;
  try {
    session = await api.session();
  } catch {
    renderForbidden();
    return;
  }
  if (!session.user?.admin) {
    renderForbidden();
    return;
  }
  renderShell(session.user);
}

boot();
