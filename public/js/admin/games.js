// admin/games.js — Game lookup tab: search (reuses the public /api/games/search endpoint), a detail
// view (raw row + links + source_records summary + overrides + conflicts from
// GET /api/admin/games/:id), an override form restricted to the allow-listed fields, and per-source
// refresh buttons (one per game_links row + every registered source).

import { searchGames } from "../api.js";
import { getAdminGame, resolveGame, refreshGame, createOverride, deleteOverride, OVERRIDABLE_FIELDS } from "./api.js";
import { escapeHtml, fmtDateTime, fmtJson, showError } from "./ui.js";

function overridesByField(overrides) {
  const map = new Map();
  for (const o of overrides) map.set(o.field, o);
  return map;
}

function detailHtml(detail) {
  const { game, links, sourceRecords, overrides, conflicts } = detail;
  const overrideMap = overridesByField(overrides);

  const linksRows = links.length
    ? links.map((l) => `<tr><td>${escapeHtml(l.source)}</td><td>${escapeHtml(l.external_id)}</td><td>${l.url ? `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(l.url)}</a>` : "-"}</td><td>${escapeHtml(l.match_method)}</td><td>${l.confidence}</td><td><button type="button" class="btn btn-small" data-refresh="${escapeHtml(l.source)}">Refresh</button></td></tr>`).join("")
    : '<tr><td colspan="6">No links.</td></tr>';

  const recordsRows = sourceRecords.length
    ? sourceRecords.map((r) => `<tr><td>${escapeHtml(r.source)}</td><td>${escapeHtml(r.status)}</td><td>${fmtDateTime(r.fetched_at)}</td><td>${r.error ? escapeHtml(r.error) : "-"}</td></tr>`).join("")
    : '<tr><td colspan="4">No source records.</td></tr>';

  const conflictsRows = conflicts.length
    ? conflicts.map((c) => `<tr><td>${escapeHtml(c.field)}</td><td>${escapeHtml(c.status)}</td><td><pre class="candidates">${fmtJson(c.candidates)}</pre></td></tr>`).join("")
    : '<tr><td colspan="3">No conflicts.</td></tr>';

  const overrideFieldOptions = OVERRIDABLE_FIELDS.map((f) => `<option value="${f}">${f}</option>`).join("");
  const overridesRows = OVERRIDABLE_FIELDS.map((f) => {
    const o = overrideMap.get(f);
    return `<tr>
      <td>${f}</td>
      <td>${o ? `<code>${fmtJson(o.value)}</code>` : '<span class="muted">-</span>'}</td>
      <td>${o ? escapeHtml(o.note || "") : ""}</td>
      <td>${o ? `<button type="button" class="btn btn-small" data-clear-override="${f}">Clear</button>` : ""}</td>
    </tr>`;
  }).join("");

  return `
    <div class="game-detail">
      <h3>#${game.id} — ${escapeHtml(game.name)}</h3>
      <p class="muted">kind=${escapeHtml(game.kind)} · steam_appid=${game.steam_appid ?? "-"} · gog_id=${game.gog_id ?? "-"} ·
        release=${escapeHtml(game.release_date || "?")} (${escapeHtml(game.release_precision)}) · gg_score=${game.gg_score ?? "-"} ·
        resolved_at=${fmtDateTime(game.resolved_at)}</p>
      <button type="button" class="btn btn-small" id="gd-resolve">Re-resolve now</button>

      <h4>Links</h4>
      <table class="admin-table"><thead><tr><th>Source</th><th>External id</th><th>URL</th><th>Match</th><th>Confidence</th><th></th></tr></thead>
        <tbody>${linksRows}</tbody></table>

      <h4>Source records</h4>
      <table class="admin-table"><thead><tr><th>Source</th><th>Status</th><th>Fetched at</th><th>Error</th></tr></thead>
        <tbody>${recordsRows}</tbody></table>

      <h4>Conflicts</h4>
      <table class="admin-table"><thead><tr><th>Field</th><th>Status</th><th>Candidates</th></tr></thead>
        <tbody>${conflictsRows}</tbody></table>

      <h4>Overrides</h4>
      <table class="admin-table"><thead><tr><th>Field</th><th>Value</th><th>Note</th><th></th></tr></thead>
        <tbody>${overridesRows}</tbody></table>

      <h4>Set override</h4>
      <div class="override-form">
        <label>Field <select id="gd-ov-field">${overrideFieldOptions}</select></label>
        <label>Value (JSON or plain text)<textarea id="gd-ov-value" rows="2"></textarea></label>
        <label>Note <input type="text" id="gd-ov-note" maxlength="255"></label>
        <button type="button" class="btn btn-small" id="gd-ov-save">Save override</button>
      </div>
    </div>
  `;
}

export function mount(container) {
  container.innerHTML = `
    <div class="panel-head"><h2>Game lookup</h2></div>
    <div class="search-row">
      <input type="search" id="gl-search" placeholder="Search games by name…" autocomplete="off">
      <ul id="gl-results" class="search-results" hidden></ul>
    </div>
    <div id="gl-error"></div>
    <div id="gl-detail"></div>
  `;

  const searchInput = container.querySelector("#gl-search");
  const resultsEl = container.querySelector("#gl-results");
  const errorEl = container.querySelector("#gl-error");
  const detailEl = container.querySelector("#gl-detail");

  let searchTimer = null;
  let currentGameId = null;

  async function loadDetail(id) {
    currentGameId = id;
    detailEl.innerHTML = "Loading…";
    try {
      const detail = await getAdminGame(id);
      errorEl.innerHTML = "";
      detailEl.innerHTML = detailHtml(detail);
    } catch (err) {
      showError(errorEl, `Failed to load game ${id}: ${err.message}`);
      detailEl.innerHTML = "";
    }
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      resultsEl.hidden = true;
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const games = await searchGames(q, "en");
        resultsEl.innerHTML = games.length
          ? games.map((g) => `<li data-id="${g.id}">#${g.id} — ${escapeHtml(g.name)}</li>`).join("")
          : '<li class="empty">No results</li>';
        resultsEl.hidden = false;
      } catch (err) {
        showError(errorEl, `Search failed: ${err.message}`);
      }
    }, 200);
  });

  resultsEl.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    e.preventDefault();
    resultsEl.hidden = true;
    searchInput.value = li.textContent;
    loadDetail(Number(li.dataset.id));
  });

  detailEl.addEventListener("click", async (e) => {
    if (!currentGameId) return;

    if (e.target.id === "gd-resolve") {
      e.target.disabled = true;
      try {
        await resolveGame(currentGameId);
        await loadDetail(currentGameId);
      } catch (err) {
        showError(errorEl, `Resolve failed: ${err.message}`);
      } finally {
        e.target.disabled = false;
      }
      return;
    }

    const refreshBtn = e.target.closest("button[data-refresh]");
    if (refreshBtn) {
      refreshBtn.disabled = true;
      try {
        await refreshGame(currentGameId, refreshBtn.dataset.refresh);
      } catch (err) {
        showError(errorEl, `Refresh failed: ${err.message}`);
      } finally {
        refreshBtn.disabled = false;
      }
      return;
    }

    const clearBtn = e.target.closest("button[data-clear-override]");
    if (clearBtn) {
      clearBtn.disabled = true;
      try {
        await deleteOverride(currentGameId, clearBtn.dataset.clearOverride);
        await loadDetail(currentGameId);
      } catch (err) {
        showError(errorEl, `Clear override failed: ${err.message}`);
      }
      return;
    }

    if (e.target.id === "gd-ov-save") {
      const field = container.querySelector("#gd-ov-field").value;
      const raw = container.querySelector("#gd-ov-value").value;
      const note = container.querySelector("#gd-ov-note").value.trim() || undefined;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      e.target.disabled = true;
      try {
        await createOverride({ gameId: currentGameId, field, value, note });
        await loadDetail(currentGameId);
      } catch (err) {
        showError(errorEl, `Override failed: ${err.message}`);
      } finally {
        e.target.disabled = false;
      }
    }
  });

  return { destroy() { clearTimeout(searchTimer); } };
}
