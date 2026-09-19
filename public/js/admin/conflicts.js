// admin/conflicts.js — Conflicts tab: list of open (by default) resolver conflicts with the game
// name, candidates rendered as readable JSON, an "Accept" action (marks the conflict resolved as-is)
// and a "Set override" form (field is pre-filled and locked to the conflict's own field).

import { getConflicts, acceptConflict, createOverride } from "./api.js";
import { escapeHtml, fmtDateTime, fmtJson, showError } from "./ui.js";

const STATUSES = ["open", "accepted", "overridden"];

function rowHtml(c) {
  return `
    <tr data-id="${c.id}" data-field="${escapeHtml(c.field)}" data-game-id="${c.game_id}">
      <td>${c.game_id} — ${escapeHtml(c.game_name || "")}</td>
      <td>${escapeHtml(c.field)}</td>
      <td><pre class="candidates">${fmtJson(c.candidates)}</pre></td>
      <td>${escapeHtml(c.reason || "")}</td>
      <td>${escapeHtml(c.status)}</td>
      <td>${fmtDateTime(c.created_at)}</td>
      <td class="cell-actions">
        ${c.status === "open" ? '<button type="button" class="btn btn-small" data-action="accept">Accept</button>' : ""}
        <button type="button" class="btn btn-small" data-action="override">Set override…</button>
      </td>
    </tr>
  `;
}

export function mount(container) {
  container.innerHTML = `
    <div class="panel-head">
      <h2>Conflicts</h2>
      <div class="filters">
        <label>Status
          <select id="cf-status">
            ${STATUSES.map((s) => `<option value="${s}" ${s === "open" ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </label>
        <label>Field <input type="text" id="cf-field" placeholder="e.g. release_date"></label>
        <button type="button" class="btn btn-small" id="cf-refresh">Refresh</button>
      </div>
    </div>
    <div id="cf-error"></div>
    <table class="admin-table">
      <thead>
        <tr><th>Game</th><th>Field</th><th>Candidates</th><th>Reason</th><th>Status</th><th>Created</th><th>Actions</th></tr>
      </thead>
      <tbody id="cf-body"><tr><td colspan="7">Loading…</td></tr></tbody>
    </table>
    <div class="pager">
      <button type="button" class="btn btn-small" id="cf-prev">&larr; Prev</button>
      <span id="cf-page">Page 1</span>
      <button type="button" class="btn btn-small" id="cf-next">Next &rarr;</button>
    </div>

    <div id="cf-override-panel" class="override-panel" hidden>
      <h3>Set override for game <span id="ov-game"></span>, field <span id="ov-field"></span></h3>
      <label>Value (JSON or plain text)<textarea id="ov-value" rows="3"></textarea></label>
      <label>Note <input type="text" id="ov-note" maxlength="255"></label>
      <div class="override-actions">
        <button type="button" class="btn btn-small" id="ov-save">Save override</button>
        <button type="button" class="btn btn-small" id="ov-cancel">Cancel</button>
      </div>
    </div>
  `;

  const body = container.querySelector("#cf-body");
  const errorEl = container.querySelector("#cf-error");
  const statusSel = container.querySelector("#cf-status");
  const fieldInput = container.querySelector("#cf-field");
  const pageLabel = container.querySelector("#cf-page");
  const overridePanel = container.querySelector("#cf-override-panel");

  let page = 1;
  let total = 0;
  const PAGE_SIZE = 50;

  async function load() {
    try {
      const { conflicts, total: t } = await getConflicts({ status: statusSel.value, field: fieldInput.value.trim(), page });
      total = t;
      errorEl.innerHTML = "";
      body.innerHTML = conflicts.length ? conflicts.map(rowHtml).join("") : '<tr><td colspan="7">No conflicts.</td></tr>';
      pageLabel.textContent = `Page ${page} of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`;
    } catch (err) {
      showError(errorEl, `Failed to load conflicts: ${err.message}`);
    }
  }

  function openOverridePanel(gameId, field) {
    overridePanel.hidden = false;
    overridePanel.dataset.gameId = gameId;
    overridePanel.dataset.field = field;
    container.querySelector("#ov-game").textContent = gameId;
    container.querySelector("#ov-field").textContent = field;
    container.querySelector("#ov-value").value = "";
    container.querySelector("#ov-note").value = "";
    overridePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  container.querySelector("#cf-refresh").addEventListener("click", () => { page = 1; load(); });
  statusSel.addEventListener("change", () => { page = 1; load(); });
  container.querySelector("#cf-prev").addEventListener("click", () => { if (page > 1) { page--; load(); } });
  container.querySelector("#cf-next").addEventListener("click", () => { if (page * PAGE_SIZE < total) { page++; load(); } });

  body.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const row = btn.closest("tr");
    const id = Number(row.dataset.id);
    const gameId = Number(row.dataset.gameId);
    const field = row.dataset.field;

    if (btn.dataset.action === "accept") {
      btn.disabled = true;
      try {
        await acceptConflict(id);
        await load();
      } catch (err) {
        showError(errorEl, `Accept failed: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
      return;
    }
    if (btn.dataset.action === "override") {
      openOverridePanel(gameId, field);
    }
  });

  container.querySelector("#ov-cancel").addEventListener("click", () => { overridePanel.hidden = true; });

  container.querySelector("#ov-save").addEventListener("click", async () => {
    const gameId = Number(overridePanel.dataset.gameId);
    const field = overridePanel.dataset.field;
    const raw = container.querySelector("#ov-value").value;
    const note = container.querySelector("#ov-note").value.trim() || undefined;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw; // plain string values (e.g. difficulty, name) don't need to be JSON-quoted
    }
    try {
      await createOverride({ gameId, field, value, note });
      overridePanel.hidden = true;
      await load();
    } catch (err) {
      showError(errorEl, `Override failed: ${err.message}`);
    }
  });

  load();

  return { destroy() {} };
}
