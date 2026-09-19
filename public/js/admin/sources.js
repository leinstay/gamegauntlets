// admin/sources.js — Sources tab: one row per registered source module (src/sources/*.js), with
// pause/resume/run controls and an auto-refresh every 10s (per the task: "table with pause/resume/
// run, auto-refresh 10 s").

import { getSources, pauseSource, resumeSource, runSource } from "./api.js";
import { escapeHtml, fmtDateTime, showError } from "./ui.js";

const REFRESH_MS = 10_000;

function fmtQueue(counts) {
  if (!counts) return '<span class="muted">n/a (queue unreachable)</span>';
  const parts = ["waiting", "active", "delayed", "completed", "failed"]
    .filter((k) => counts[k] !== undefined)
    .map((k) => `${k}: ${counts[k]}`);
  return parts.join(", ") || "-";
}

function rowHtml(source) {
  const statusBadge = source.paused
    ? '<span class="badge badge-warn">paused</span>'
    : source.enabled
      ? '<span class="badge badge-ok">running</span>'
      : '<span class="badge">disabled</span>';

  return `
    <tr data-source="${escapeHtml(source.name)}">
      <td><strong>${escapeHtml(source.name)}</strong></td>
      <td>${statusBadge}</td>
      <td>${fmtDateTime(source.lastRunAt)}</td>
      <td>${fmtDateTime(source.lastFullPassAt)}</td>
      <td class="cell-error">${source.lastError ? escapeHtml(source.lastError) : "-"}</td>
      <td>${fmtQueue(source.queueCounts)}</td>
      <td>${source.recordsCount.toLocaleString()}</td>
      <td>${source.linksCount.toLocaleString()}</td>
      <td class="cell-actions">
        <button type="button" class="btn btn-small" data-action="${source.paused ? "resume" : "pause"}">
          ${source.paused ? "Resume" : "Pause"}
        </button>
        <button type="button" class="btn btn-small" data-action="run">Run now</button>
      </td>
    </tr>
  `;
}

export function mount(container) {
  container.innerHTML = `
    <div class="panel-head">
      <h2>Sources</h2>
      <span class="muted" id="sources-updated"></span>
    </div>
    <div id="sources-error"></div>
    <table class="admin-table">
      <thead>
        <tr>
          <th>Source</th><th>Status</th><th>Last run</th><th>Last full pass</th>
          <th>Last error</th><th>Queue</th><th>Records</th><th>Links</th><th>Actions</th>
        </tr>
      </thead>
      <tbody id="sources-body"><tr><td colspan="9">Loading…</td></tr></tbody>
    </table>
  `;

  const body = container.querySelector("#sources-body");
  const updatedEl = container.querySelector("#sources-updated");
  const errorEl = container.querySelector("#sources-error");
  let timer = null;
  let busy = false;

  async function load() {
    try {
      const { sources } = await getSources();
      errorEl.innerHTML = "";
      body.innerHTML = sources.length
        ? sources.map(rowHtml).join("")
        : '<tr><td colspan="9">No source modules registered.</td></tr>';
      updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      showError(errorEl, `Failed to load sources: ${err.message}`);
    }
  }

  body.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || busy) return;
    const row = btn.closest("tr");
    const name = row.dataset.source;
    const action = btn.dataset.action;
    busy = true;
    btn.disabled = true;
    try {
      if (action === "pause") await pauseSource(name);
      else if (action === "resume") await resumeSource(name);
      else if (action === "run") await runSource(name);
      await load();
    } catch (err) {
      showError(errorEl, `Action failed: ${err.message}`);
    } finally {
      busy = false;
    }
  });

  load();
  timer = setInterval(load, REFRESH_MS);

  return {
    destroy() {
      if (timer) clearInterval(timer);
    },
  };
}
