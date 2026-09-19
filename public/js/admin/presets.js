// admin/presets.js — Presets tab: list existing presets, edit name/sort order, add games to a preset
// by search (reuses /api/games/search), remove games, create new, delete.

import { searchGames } from "../api.js";
import { getPresets, createPreset, updatePreset, deletePreset } from "./api.js";
import { escapeHtml, showError } from "./ui.js";

function presetHtml(preset, gameNames) {
  const games = preset.gameIds.map((id) => `
    <li data-id="${id}">
      #${id} — ${escapeHtml(gameNames.get(id) || "?")}
      <button type="button" class="btn btn-tiny" data-remove-game="${id}">&times;</button>
    </li>
  `).join("");

  return `
    <div class="preset-card" data-preset-id="${preset.id}">
      <div class="preset-head">
        <input type="text" class="preset-name" value="${escapeHtml(preset.name)}">
        <label>Order <input type="number" class="preset-order" value="${preset.sortOrder}" style="width:4em"></label>
        <button type="button" class="btn btn-small" data-action="save">Save</button>
        <button type="button" class="btn btn-small" data-action="delete">Delete</button>
      </div>
      <ul class="preset-games">${games || '<li class="empty">No games yet.</li>'}</ul>
      <div class="preset-add">
        <input type="search" class="preset-add-input" placeholder="Add game by name…" autocomplete="off">
        <ul class="search-results" hidden></ul>
      </div>
    </div>
  `;
}

export function mount(container) {
  container.innerHTML = `
    <div class="panel-head">
      <h2>Presets</h2>
      <button type="button" class="btn btn-small" id="pr-new">+ New preset</button>
    </div>
    <div id="pr-error"></div>
    <div id="pr-list">Loading…</div>
  `;

  const listEl = container.querySelector("#pr-list");
  const errorEl = container.querySelector("#pr-error");
  const gameNames = new Map(); // id -> name, filled in as search results come back

  async function load() {
    try {
      const presets = await getPresets();
      errorEl.innerHTML = "";
      listEl.innerHTML = presets.length ? presets.map((p) => presetHtml(p, gameNames)).join("") : "<p>No presets yet.</p>";
    } catch (err) {
      showError(errorEl, `Failed to load presets: ${err.message}`);
    }
  }

  container.querySelector("#pr-new").addEventListener("click", async () => {
    try {
      await createPreset({ name: "New preset", sortOrder: 0, gameIds: [] });
      await load();
    } catch (err) {
      showError(errorEl, `Create failed: ${err.message}`);
    }
  });

  listEl.addEventListener("click", async (e) => {
    const card = e.target.closest(".preset-card");
    if (!card) return;
    const presetId = Number(card.dataset.presetId);

    if (e.target.dataset.action === "save") {
      const name = card.querySelector(".preset-name").value.trim();
      const sortOrder = Number(card.querySelector(".preset-order").value) || 0;
      const gameIds = [...card.querySelectorAll(".preset-games li[data-id]")].map((li) => Number(li.dataset.id));
      e.target.disabled = true;
      try {
        await updatePreset(presetId, { name, sortOrder, gameIds });
        await load();
      } catch (err) {
        showError(errorEl, `Save failed: ${err.message}`);
      } finally {
        e.target.disabled = false;
      }
      return;
    }

    if (e.target.dataset.action === "delete") {
      if (!window.confirm("Delete this preset?")) return;
      try {
        await deletePreset(presetId);
        await load();
      } catch (err) {
        showError(errorEl, `Delete failed: ${err.message}`);
      }
      return;
    }

    const removeBtn = e.target.closest("button[data-remove-game]");
    if (removeBtn) {
      removeBtn.closest("li").remove();
    }
  });

  // Debounced game search per preset card, added to the DOM without a rebuild (so an in-progress
  // edit of name/order/games in other cards isn't lost).
  let searchTimer = null;
  listEl.addEventListener("input", (e) => {
    if (!e.target.classList.contains("preset-add-input")) return;
    clearTimeout(searchTimer);
    const input = e.target;
    const resultsEl = input.nextElementSibling;
    const q = input.value.trim();
    if (!q) {
      resultsEl.hidden = true;
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const games = await searchGames(q, "en");
        for (const g of games) gameNames.set(g.id, g.name);
        resultsEl.innerHTML = games.length
          ? games.map((g) => `<li data-id="${g.id}">#${g.id} — ${escapeHtml(g.name)}</li>`).join("")
          : '<li class="empty">No results</li>';
        resultsEl.hidden = false;
      } catch (err) {
        showError(errorEl, `Search failed: ${err.message}`);
      }
    }, 200);
  });

  listEl.addEventListener("mousedown", (e) => {
    const li = e.target.closest(".preset-add .search-results li[data-id]");
    if (!li) return;
    e.preventDefault();
    const card = li.closest(".preset-card");
    const gamesUl = card.querySelector(".preset-games");
    const id = Number(li.dataset.id);
    if (![...gamesUl.querySelectorAll("li[data-id]")].some((existing) => Number(existing.dataset.id) === id)) {
      gamesUl.querySelector(".empty")?.remove();
      const item = document.createElement("li");
      item.dataset.id = id;
      item.innerHTML = `#${id} — ${escapeHtml(gameNames.get(id) || "?")} <button type="button" class="btn btn-tiny" data-remove-game="${id}">&times;</button>`;
      gamesUl.appendChild(item);
    }
    const resultsEl = li.closest(".search-results");
    resultsEl.hidden = true;
    card.querySelector(".preset-add-input").value = "";
  });

  load();

  return { destroy() { clearTimeout(searchTimer); } };
}
