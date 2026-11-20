importScripts("shared.js");

/* ---------------------------------------------------------------------------
   Job state lives in chrome.storage.local so the queue survives restarts.
   A job is: queued -> running -> done | error | paused | canceled
   "Pause" stops the helper but keeps the partial file; "Resume" continues it.
--------------------------------------------------------------------------- */
let jobs = {};
const ports = new Map();      // jobId -> native port of a running job
const stopWanted = new Map(); // jobId -> "pause" | "cancel" (what the user asked for)
let saveTimer = null;

const ready = (async () => {
  jobs = (await chrome.storage.local.get("jobs")).jobs || {};
  // Anything marked running has no live helper after a restart, so it was interrupted.
  for (const j of Object.values(jobs)) {
    if (j.status === "running") Object.assign(j, { status: "paused", stage: "Interrupted", speed: null, eta: null });
  }
  await save(true);
  pump();
})();

function save(now) {
  clearTimeout(saveTimer);
  if (now) return chrome.storage.local.set({ jobs });
  saveTimer = setTimeout(() => chrome.storage.local.set({ jobs }), 400);
}

function patch(job, p, now) {
  Object.assign(job, p, { updated: Date.now() });
  save(now);
  badge();
}

function badge() {
  const active = Object.values(jobs).filter((j) => j.status === "running" || j.status === "queued").length;
  chrome.action.setBadgeText({ text: active ? String(active) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#4361ee" });
}

function addJob(job) {
  jobs[job.id] = job;
  const finished = Object.values(jobs).filter((j) => ["done", "error", "canceled"].includes(j.status)).sort((a, b) => a.updated - b.updated);
  while (Object.keys(jobs).length > 150 && finished.length) delete jobs[finished.shift().id];
  save(true);
}

/* ---------- scheduler ---------- */
async function pump() {
  await ready;
  const st = await CG.getSettings();
  let running = Object.values(jobs).filter((j) => j.status === "running").length;
  const queued = Object.values(jobs).filter((j) => j.status === "queued").sort((a, b) => a.created - b.created);
  for (const j of queued) {
    if (running >= Math.max(1, st.maxParallel)) break;
    running++;
    start(j, st);
  }
  badge();
}

function start(job, st) {
  stopWanted.delete(job.id);
  patch(job, { status: "running", error: null, stage: "Starting", speed: null, eta: null }, true);
  if (job.tool === "chrome") return startChrome(job, st);

  let port, finished = false;
  try { port = chrome.runtime.connectNative(CG.HOST); }
  catch (e) { return patch(job, { status: "error", error: CG.friendlyHostError(e.message) }, true); }
  ports.set(job.id, port);

  port.onMessage.addListener((m) => {
    if (m.type === "progress") {
      patch(job, { pct: m.pct ?? job.pct, speed: m.speed ?? null, eta: m.eta ?? null, stage: m.stage || job.stage });
    } else if (m.type === "done") {
      finished = true;
      ports.delete(job.id);
      onDone(job, m);
    }
  });
  port.onDisconnect.addListener(() => {
    ports.delete(job.id);
    const err = chrome.runtime.lastError?.message;
    if (!finished && job.status === "running") {
      const want = stopWanted.get(job.id);
      if (want === "cancel") patch(job, { status: "canceled", speed: null, eta: null }, true);
      else if (want === "pause") patch(job, { status: "paused", stage: "Paused", speed: null, eta: null }, true);
      else patch(job, { status: "error", error: CG.friendlyHostError(err) }, true);
    }
    pump();
  });
  port.postMessage({
    action: "download",
    job: { id: job.id, url: job.url, tool: job.tool, kind: job.kind, spec: job.spec },
    settings: { dir: st.dir, template: st.template, cookies: st.cookies },
  });
}

function onDone(job, m) {
  stopWanted.delete(job.id);
  const clear = { speed: null, eta: null };
  if (m.status === "done") {
    patch(job, { ...clear, status: "done", pct: 100, stage: "Done", file: m.file || null, dir: m.dir || null, finished: Date.now(), error: null }, true);
    notify(job, "Download finished", job.title);
  } else if (m.status === "paused") {
    patch(job, { ...clear, status: "paused", stage: "Paused" }, true);
  } else if (m.status === "canceled") {
    patch(job, { ...clear, status: "canceled", stage: "Canceled" }, true);
  } else {
    patch(job, { ...clear, status: "error", error: m.error || "Download failed" }, true);
    notify(job, "Download failed", (m.error || "").slice(0, 120));
  }
  pump();
}

async function startChrome(job, st) {
  try {
    let r;
    if (job.spec.fmt == null) r = { url: job.url, filename: job.spec.filename };
    else {
      r = await CG.nativeCall({ action: "geturl", url: job.url, fmt: job.spec.fmt, cookies: st.cookies }, null, ["link"]);
      if (r.error) throw new Error(r.error);
    }
    const name = (r.filename || "download").replace(/[\\/:*?"<>|]+/g, "_");
    const id = await chrome.downloads.download({ url: r.url, filename: "TurboFetch/" + name, conflictAction: "uniquify" });
    patch(job, { status: "running", pct: 0, stage: "Downloading in Chrome", chromeId: id }, true);
  } catch (e) {
    patch(job, { status: "error", error: e.message }, true);
  }
  pump();
}

/* ---------- user actions ---------- */
function pause(id) {
  const j = jobs[id];
  if (!j) return;
  if (j.status === "queued") return patch(j, { status: "paused", stage: "Paused" }, true);
  if (j.tool === "chrome" && j.chromeId != null && j.status === "running") {
    chrome.downloads.pause(j.chromeId).then(() => patch(j, { status: "paused", stage: "Paused in Chrome", speed: null, eta: null }, true)).catch((e) => patch(j, { error: e.message }, true));
    return;
  }
  if (j.status !== "running") return;
  stopWanted.set(id, "pause");
  const p = ports.get(id);
  if (p) p.postMessage({ action: "pause" });
  else patch(j, { status: "paused", stage: "Paused" }, true);
}

function resume(id) {
  const j = jobs[id];
  if (j?.tool === "chrome" && j.chromeId != null && j.status === "paused") {
    chrome.downloads.resume(j.chromeId).then(() => patch(j, { status: "running", error: null, stage: "Downloading in Chrome" }, true)).catch((e) => patch(j, { status: "error", error: e.message }, true));
    return;
  }
  if (j && ["paused", "error", "canceled"].includes(j.status)) {
    patch(j, { status: "queued", error: null, stage: "Waiting", ...(j.status === "canceled" ? { pct: 0 } : {}) }, true);
    pump();
  }
}

function cancel(id) {
  const j = jobs[id];
  if (!j) return;
  if (j.tool === "chrome" && j.chromeId != null && ["running", "paused"].includes(j.status)) {
    chrome.downloads.cancel(j.chromeId).then(() => patch(j, { status: "canceled", stage: "Canceled", speed: null, eta: null }, true)).catch((e) => patch(j, { status: "error", error: e.message }, true));
  } else if (j.status === "running" && ports.get(id)) {
    stopWanted.set(id, "cancel");
    ports.get(id).postMessage({ action: "cancel" });
  } else if (["queued", "paused", "error"].includes(j.status)) {
    patch(j, { status: "canceled", stage: "Canceled", speed: null, eta: null }, true);
    CG.nativeCall({ action: "cleanup", id }).catch(() => {});
    pump();
  }
}

function remove(id) {
  const j = jobs[id];
  if (!j) return;
  if (j.status === "running") cancel(id);
  else if (j.status !== "done") CG.nativeCall({ action: "cleanup", id }).catch(() => {});
  delete jobs[id];
  save(true);
  badge();
}

function bulk(op) {
  for (const j of Object.values(jobs)) {
    if (op === "pauseAll" && ["running", "queued"].includes(j.status)) pause(j.id);
    if (op === "resumeAll" && j.status === "paused") resume(j.id);
    if (op === "cancelAll" && ["running", "queued", "paused"].includes(j.status)) cancel(j.id);
    if (op === "clearFinished" && ["done", "canceled", "error"].includes(j.status)) delete jobs[j.id];
  }
  save(true);
  badge();
  pump();
}

function notify(job, title, message) {
  CG.getSettings().then((st) => {
    if (!st.notify) return;
    chrome.notifications.create(job.id, { type: "basic", iconUrl: "icons/128.png", title, message: message || "" }, () => void chrome.runtime.lastError);
  });
}
chrome.downloads.onChanged.addListener((delta) => {
  const job = Object.values(jobs).find((j) => j.tool === "chrome" && j.chromeId === delta.id);
  if (!job) return;
  if (delta.state?.current === "complete") {
    patch(job, { status: "done", pct: 100, stage: "Done", finished: Date.now(), speed: null, eta: null }, true);
    notify(job, "Download finished", job.title);
    pump();
  } else if (delta.state?.current === "interrupted") {
    const reason = delta.error?.current || "The browser download was interrupted.";
    patch(job, { status: "error", error: reason, stage: "Interrupted", speed: null, eta: null }, true);
    notify(job, "Download failed", reason);
    pump();
  } else if (delta.paused?.current === true) {
    patch(job, { status: "paused", stage: "Paused in Chrome", speed: null, eta: null }, true);
  } else if (delta.paused?.current === false) {
    patch(job, { status: "running", stage: "Downloading in Chrome" }, true);
  }
  if (delta.totalBytes?.current > 0 && delta.bytesReceived?.current != null) {
    patch(job, { pct: Math.min(99.5, delta.bytesReceived.current / delta.totalBytes.current * 100) });
  }
});

chrome.notifications.onClicked.addListener((id) => {
  const j = jobs[id];
  if (j?.status === "done") CG.nativeCall({ action: "reveal", path: j.file, dir: j.dir }).catch(() => {});
  else CG.openManager();
  chrome.notifications.clear(id);
});

/* ---------- probing (what formats does this link really have?) ---------- */
const probeCache = new Map();
async function probe(url) {
  const st = await CG.getSettings();
  const key = [url, st.compat, st.cookies].join("|");
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.p;
  const p = CG.nativeCall({ action: "probe", url, compat: st.compat, cookies: st.cookies }, null, ["probe"]).then((m) => {
    if (m.error) { const e = new Error(m.error); e.code = m.code; throw e; }
    m.url = url;
    return m;
  });
  probeCache.set(key, { t: Date.now(), p });
  p.catch(() => probeCache.delete(key));
  return p;
}

async function enqueue(url, choice, later) {
  const [p, st] = await Promise.all([probe(url), CG.getSettings()]);
  const job = CG.makeJob(p, choice || CG.defaultChoice(p, st), st);
  if (later) Object.assign(job, { status: "paused", stage: "Saved for later" });
  addJob(job);
  pump();
  return job.id;
}

async function quickAdd(url) {
  chrome.action.setBadgeText({ text: "…" });
  try { await enqueue(url); }
  catch (e) {
    notify({ id: "err" + Date.now() }, "Could not add download", e.message.slice(0, 120));
    badge();
  }
}

/* ---------- messages from the popup, manager and YouTube button ---------- */
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    await ready;
    try {
      switch (msg.type) {
        case "probe": return respond({ ok: true, data: await probe(msg.url) });
        case "enqueue": return respond({ ok: true, id: await enqueue(msg.url, msg.choice, msg.later) });
        case "quick": return respond({ ok: true, id: await enqueue(msg.url) });
        case "job": ({ pause, resume, retry: resume, cancel, remove })[msg.op]?.(msg.id); return respond({ ok: true });
        case "bulk": bulk(msg.op); return respond({ ok: true });
        case "openManager": CG.openManager(msg.hash); return respond({ ok: true });
        default: return respond({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      respond({ ok: false, error: e.message, code: e.code });
    }
  })();
  return true; // async response
});

/* ---------- right-click menu ---------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "grab", title: "Download with TurboFetch", contexts: ["page", "link", "video", "audio"] });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const src = info.srcUrl && /^https?:/.test(info.srcUrl) ? info.srcUrl : null;
  const url = info.linkUrl || src || info.pageUrl;
  if (url) quickAdd(url);
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.maxParallel) pump();
});
