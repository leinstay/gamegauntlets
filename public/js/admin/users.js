// admin/users.js — Users tab: search by name/steamid, set level (1..6 or none) and status
// (normal/streamer).

import { getUsers, updateUser } from "./api.js";
import { escapeHtml, fmtDateTime, showError } from "./ui.js";

const LEVELS = [null, 1, 2, 3, 4, 5, 6];

function rowHtml(user) {
  const levelOptions = LEVELS.map(
    (lvl) => `<option value="${lvl ?? ""}" ${user.level === lvl ? "selected" : ""}>${lvl ?? "none"}</option>`,
  ).join("");

  return `
    <tr data-steamid="${escapeHtml(user.steamid)}">
      <td>${user.avatar ? `<img class="avatar" src="${escapeHtml(user.avatar)}" alt="">` : ""} ${escapeHtml(user.name || "")}</td>
      <td>${escapeHtml(user.steamid)}</td>
      <td><select class="user-level">${levelOptions}</select></td>
      <td>
        <select class="user-status">
          <option value="normal" ${user.status === "normal" ? "selected" : ""}>normal</option>
          <option value="streamer" ${user.status === "streamer" ? "selected" : ""}>streamer</option>
        </select>
      </td>
      <td>${fmtDateTime(user.last_login_at)}</td>
      <td><button type="button" class="btn btn-small" data-action="save">Save</button></td>
    </tr>
  `;
}

export function mount(container) {
  container.innerHTML = `
    <div class="panel-head">
      <h2>Users</h2>
      <input type="search" id="us-search" placeholder="Search by name or Steam ID…" autocomplete="off">
    </div>
    <div id="us-error"></div>
    <table class="admin-table">
      <thead><tr><th>Name</th><th>Steam ID</th><th>Level</th><th>Status</th><th>Last login</th><th></th></tr></thead>
      <tbody id="us-body"><tr><td colspan="6">Loading…</td></tr></tbody>
    </table>
  `;

  const body = container.querySelector("#us-body");
  const errorEl = container.querySelector("#us-error");
  const searchInput = container.querySelector("#us-search");
  let searchTimer = null;

  async function load(q = "") {
    try {
      const { users } = await getUsers({ q });
      errorEl.innerHTML = "";
      body.innerHTML = users.length ? users.map(rowHtml).join("") : '<tr><td colspan="6">No users found.</td></tr>';
    } catch (err) {
      showError(errorEl, `Failed to load users: ${err.message}`);
    }
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => load(searchInput.value.trim()), 250);
  });

  body.addEventListener("click", async (e) => {
    if (e.target.dataset.action !== "save") return;
    const row = e.target.closest("tr");
    const steamid = row.dataset.steamid;
    const levelRaw = row.querySelector(".user-level").value;
    const level = levelRaw === "" ? null : Number(levelRaw);
    const status = row.querySelector(".user-status").value;

    e.target.disabled = true;
    try {
      await updateUser(steamid, { level, status });
    } catch (err) {
      showError(errorEl, `Save failed: ${err.message}`);
    } finally {
      e.target.disabled = false;
    }
  });

  load();

  return { destroy() { clearTimeout(searchTimer); } };
}
