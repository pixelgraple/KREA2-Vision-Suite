"use strict";

const byId = id => document.getElementById(id);
const state = {
  jobs: [], queue: [], selected: null, filter: "all", page: 1,
  pagination: {page: 1, page_size: 20, total_items: 0, total_pages: 1},
  timer: null, detailToken: 0, refreshToken: 0
};

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = text;
  return element;
}

function setConnection(online, label) {
  const indicator = byId("connection");
  indicator.className = `connection ${online ? "online" : "offline"}`;
  indicator.replaceChildren(node("i"), document.createTextNode(label));
}

function formatAge(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}

function formatClock(timestamp) {
  if (!timestamp) return "—";
  return new Date(Number(timestamp) * 1000).toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });
}

function hashLabel(job) {
  const digest = String(job.image_hash || "");
  return digest ? `${digest.slice(0, 12)}…` : "Unknown image";
}

function statusBadge(status) {
  return node("span", `status ${status}`, status);
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function renderStats(summary = {}) {
  byId("stat-queued").textContent = String(summary.queued || 0);
  byId("stat-running").textContent = String(summary.running || 0);
  byId("stat-completed").textContent = String(summary.completed_24h || 0);
  byId("stat-rejected").textContent = String(summary.rejected || 0);
  byId("stat-errors").textContent = String(summary.errors || 0);
}

function renderQueue(queue = {count: 0, entries: []}) {
  state.queue = Array.isArray(queue.entries) ? queue.entries : [];
  byId("queue-count").textContent = `${Number(queue.count) || 0} ${Number(queue.count) === 1 ? "job" : "jobs"}`;
  const root = byId("queue");
  if (queue.enabled === false) {
    const empty = node("div", "empty");
    empty.append(node("h3", "", "Shared queue is disabled"), node("p", "", "Enable the Forge/Ollama FIFO before running Discord Vision."));
    root.replaceChildren(empty);
    return;
  }
  if (!state.queue.length) {
    const empty = node("div", "empty");
    empty.append(node("h3", "", "GPU queue is clear"), node("p", "", "Discord Vision or Forge will appear here the moment work is queued."));
    root.replaceChildren(empty);
    return;
  }
  root.replaceChildren(...state.queue.map(item => {
    const card = node("article", `queue-item${item.head ? " head" : ""}`);
    card.append(
      node("span", "queue-position", String(item.position)),
      node("strong", "", String(item.worker || "Local GPU job")),
      node("small", "", `${item.head ? "Using the GPU" : "Waiting"} · ${formatAge(item.age_seconds)}`)
    );
    return card;
  }));
}

function renderScheduler(scheduler = {}) {
  const warm = scheduler.warm || {};
  const next = scheduler.next_eligible_job || {};
  const warmStatus = byId("warm-status");
  const warmDetail = byId("warm-detail");
  if (warm.active) {
    warmStatus.textContent = `${warm.model_id || "Heretic"} resident · ${Number(warm.seconds_remaining || 0).toFixed(1)}s left`;
    warmDetail.textContent = "Only while the shared GPU is idle; any Forge/Krea/other ticket evicts it first.";
  } else {
    warmStatus.textContent = "Not resident";
    warmDetail.textContent = `15s opportunistic window · last eviction: ${String(warm.last_eviction_reason || "—")}`;
  }
  byId("next-job").textContent = next.worker || "No queued worker";
  byId("next-job-detail").textContent = next.reason || "A new Discord image enters at the FIFO tail.";
}

function filteredJobs() {
  if (state.filter === "active") return state.jobs.filter(job => ["queued", "running"].includes(job.status));
  if (state.filter === "completed") return state.jobs.filter(job => job.status === "completed");
  if (state.filter === "attention") return state.jobs.filter(job => ["rejected", "error", "cancelled"].includes(job.status));
  return state.jobs;
}

function renderJobs() {
  const jobs = filteredJobs();
  const root = byId("jobs");
  if (!jobs.length) {
    const empty = node("div", "empty");
    const title = state.jobs.length ? "Nothing in this filter" : "No Discord Vision jobs yet";
    const message = state.jobs.length
      ? "Choose another filter to see your local job history."
      : "Hover a Discord attachment and click 🔍. This page will update automatically.";
    empty.append(node("span", "empty-mark", "🔍"), node("h3", "", title), node("p", "", message));
    root.replaceChildren(empty);
    return;
  }
  root.replaceChildren(...jobs.map(job => {
    const button = node("button", `job${job.id === state.selected ? " selected" : ""}`);
    button.type = "button";
    button.setAttribute("aria-label", `Open ${job.status} Vision job for ${hashLabel(job)}`);
    button.addEventListener("click", () => selectJob(job.id));
    const body = node("span", "job-body");
    const title = node("span", "job-title");
    title.append(statusBadge(job.status), node("strong", "", hashLabel(job)));
    body.append(title, node("span", "job-stage", job.stage || "Waiting for status"));
    if (job.prompt_preview) body.append(node("span", "job-preview", job.prompt_preview));
    if (job.public_error) body.append(node("span", "job-preview", job.public_error));
    button.append(
      node("span", "job-icon", job.status === "running" ? "AI" : job.status === "queued" ? "Q" : job.status === "completed" ? "✓" : "!"),
      body,
      node("span", "job-time", formatClock(job.finished || job.created))
    );
    return button;
  }));
}

function renderPagination() {
  const pagination = state.pagination || {};
  const page = Math.max(1, Number(pagination.page) || 1);
  const totalPages = Math.max(1, Number(pagination.total_pages) || 1);
  const totalItems = Math.max(0, Number(pagination.total_items) || 0);
  byId("page-label").textContent = `Page ${page} of ${totalPages} · ${totalItems} ${totalItems === 1 ? "job" : "jobs"}`;
  byId("page-previous").disabled = page <= 1;
  byId("page-next").disabled = page >= totalPages;
}

function renderDetail(job) {
  byId("detail-empty").hidden = true;
  byId("detail").hidden = false;
  const badge = byId("detail-status");
  badge.className = `status ${job.status}`;
  badge.textContent = job.status;
  const titles = {
    queued: "Waiting for the GPU",
    running: "KREA2 Vision is working",
    completed: "Completed KREA2 prompt",
    rejected: "Rejected safely",
    error: "Vision job stopped safely"
  };
  byId("detail-title").textContent = titles[job.status] || "Discord Vision job";
  byId("detail-hash").textContent = job.image_hash || "—";
  byId("detail-duration").textContent = formatAge(job.duration_seconds);
  byId("detail-words").textContent = job.prompt_words ? String(job.prompt_words) : "—";
  byId("detail-model").textContent = job.model || "—";
  const queueText = job.status === "queued" && job.queue_ahead
    ? ` · ${job.queue_ahead} ${job.queue_ahead === 1 ? "job" : "jobs"} ahead`
    : "";
  byId("detail-stage").textContent = `${job.stage || "Waiting for status"}${queueText}`;
  const prompt = String(job.prompt || "");
  byId("prompt").value = prompt || job.public_error || "The prompt will appear here after the local composer finishes.";
  byId("copy-prompt").disabled = !prompt;
}

function clearDetail(message = "Click an item to inspect its status. Completed jobs reveal the full local prompt here.") {
  state.detailToken += 1;
  byId("detail").hidden = true;
  byId("detail-empty").hidden = false;
  const paragraph = byId("detail-empty").querySelector("p");
  if (paragraph) paragraph.textContent = message;
  byId("prompt").value = "";
  byId("copy-prompt").disabled = true;
}

async function requestJson(url) {
  const response = await fetch(url, {cache: "no-store", headers: {Accept: "application/json"}});
  const body = await response.json().catch(() => ({detail: "Unexpected Studio response."}));
  if (!response.ok) throw new Error(body.detail || `Studio returned HTTP ${response.status}.`);
  return body;
}

async function selectJob(jobId, quiet = false) {
  state.selected = jobId;
  renderJobs();
  const summary = state.jobs.find(job => job.id === jobId);
  if (summary) {
    renderDetail({...summary, prompt: "", public_error: ""});
    byId("detail-stage").textContent = "Loading current job details…";
    byId("prompt").value = "Loading current job details…";
    byId("copy-prompt").disabled = true;
  } else {
    clearDetail("That job is no longer in the recent local history.");
    return;
  }
  const token = ++state.detailToken;
  try {
    const job = await requestJson(`/api/discord-jobs/${encodeURIComponent(jobId)}`);
    if (token === state.detailToken && state.selected === jobId) renderDetail(job);
  } catch (error) {
    if (token === state.detailToken && state.selected === jobId) {
      byId("detail-stage").textContent = "Could not load this job safely.";
      byId("prompt").value = "Prompt unavailable. Refresh the dashboard and try this job again.";
      byId("copy-prompt").disabled = true;
    }
    if (!quiet) showToast(error.message);
  }
}

function schedule(active) {
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(refresh, active ? 1500 : 5000);
}

async function refresh(manual = false) {
  window.clearTimeout(state.timer);
  const token = ++state.refreshToken;
  try {
    const views = {all: "recent", active: "queued", completed: "completed", attention: "errors"};
    const params = new URLSearchParams({
      page: String(state.page), page_size: "20", view: views[state.filter] || "recent"
    });
    const payload = await requestJson(`/api/discord-jobs?${params}`);
    if (token !== state.refreshToken) return;
    state.jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    state.pagination = payload.pagination || state.pagination;
    state.page = Math.max(1, Number(state.pagination.page) || 1);
    renderStats(payload.summary);
    renderQueue(payload.queue);
    renderScheduler(payload.scheduler);
    renderJobs();
    renderPagination();
    setConnection(true, "Studio online");
    byId("last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], {hour: "numeric", minute: "2-digit", second: "2-digit"})}`;
    if (state.selected && state.jobs.some(job => job.id === state.selected)) {
      await selectJob(state.selected, true);
    } else if (state.selected) {
      state.selected = null;
      clearDetail("That job has left the bounded recent history.");
      renderJobs();
    } else if (!state.selected && state.jobs.length) {
      await selectJob(state.jobs[0].id, true);
    }
    if (token !== state.refreshToken) return;
    if (manual) showToast("Dashboard refreshed.");
    schedule(state.jobs.some(job => ["queued", "running"].includes(job.status)));
  } catch (error) {
    if (token !== state.refreshToken) return;
    setConnection(false, "Studio unavailable");
    byId("last-updated").textContent = error.message;
    schedule(false);
  }
}

document.querySelectorAll(".filter").forEach(button => {
  button.setAttribute("aria-pressed", String(button.classList.contains("active")));
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter || "all";
    state.page = 1;
    document.querySelectorAll(".filter").forEach(item => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    void refresh();
  });
});

byId("refresh").addEventListener("click", () => refresh(true));
byId("page-previous").addEventListener("click", () => {
  if (state.page <= 1) return;
  state.page -= 1;
  void refresh();
});
byId("page-next").addEventListener("click", () => {
  const totalPages = Math.max(1, Number(state.pagination?.total_pages) || 1);
  if (state.page >= totalPages) return;
  state.page += 1;
  void refresh();
});
byId("copy-prompt").addEventListener("click", async () => {
  const prompt = byId("prompt").value;
  if (!prompt) return;
  try {
    await navigator.clipboard.writeText(prompt);
    showToast("Prompt copied.");
  } catch {
    byId("prompt").select();
    showToast("Prompt selected — press Ctrl+C to copy.");
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

refresh();
