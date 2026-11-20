const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const I = CG.icon;
const esc = CG.esc;
let st = {}, jobsData = {}, filter = "all", lastTools = null, latestTag = null;
// Replace this placeholder with your preferred donation page before publishing.
const DONATION_URL = "https://github.com/head-less-ghost";

function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = Object.assign(document.createElement("div"), { className: "toast", textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2400);
}
const fillIcons = () => $$("[data-ic]").forEach((e) => { e.innerHTML = I(e.dataset.ic, +(e.dataset.s || 18)); e.style.display = "inline-flex"; });

/* ------------------------------------------------------------------ routing */
const VIEWS = ["downloads", "settings", "setup"];
function route() {
  const h = location.hash.slice(1);
  const v = VIEWS.includes(h) ? h : "downloads";
  VIEWS.forEach((x) => ($("#v-" + x).hidden = x !== v));
  $$("#nav a").forEach((a) => a.setAttribute("aria-current", a.dataset.view === v ? "page" : "false"));
  if (v === "setup") loadSetup();
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
addEventListener("hashchange", route);

/* ------------------------------------------------------------------ downloads */
const RANK = { running: 0, queued: 1, paused: 2, error: 3, done: 4, canceled: 4 };
const FILTERS = {
  all: () => true,
  active: (j) => j.status === "running" || j.status === "queued",
  paused: (j) => j.status === "paused",
  done: (j) => j.status === "done",
  failed: (j) => j.status === "error" || j.status === "canceled",
};
const EMPTY = {
  all: ["No downloads yet", "Open a video, click the TurboFetch icon, and pick a quality."],
  active: ["Nothing is downloading", "Active and waiting downloads show up here."],
  paused: ["Nothing is paused", "Pause a download, or use “Download later” in the popup, and it waits here."],
  done: ["No finished downloads", "Completed downloads stay here until you clear them."],
  failed: ["No failed downloads", "Good news. Failed and canceled downloads would appear here."],
};

function renderDownloads() {
  const all = Object.values(jobsData);
  const list = all.filter(FILTERS[filter]).sort((a, b) => RANK[a.status] - RANK[b.status] || (RANK[a.status] <= 2 ? a.created - b.created : b.updated - a.updated));
  JobsUI.sync($("#list"), list);
  $("#empty").hidden = list.length > 0;
  [$("#emptyTitle").textContent, $("#emptySub").textContent] = EMPTY[filter];

  const run = all.filter((j) => j.status === "running"), wait = all.filter((j) => j.status === "queued"), hold = all.filter((j) => j.status === "paused");
  const speed = run.reduce((n, j) => n + (j.speed || 0), 0);
  const bits = [];
  if (run.length) bits.push(`${run.length} downloading${speed ? " at " + CG.fmtSpeed(speed) : ""}`);
  if (wait.length) bits.push(`${wait.length} waiting`);
  if (hold.length) bits.push(`${hold.length} paused`);
  $("#summary").textContent = bits.join(" · ") || "Nothing running.";
  const n = run.length + wait.length;
  $("#navCount").hidden = !n;
  $("#navCount").textContent = n;
}

JobsUI.bind($("#list"), toast);
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  filter = b.dataset.f;
  $$("#filters button").forEach((x) => x.setAttribute("aria-selected", x === b));
  renderDownloads();
});
$$("[data-bulk]").forEach((b) => b.addEventListener("click", () => chrome.runtime.sendMessage({ type: "bulk", op: b.dataset.bulk })));

async function quickAdd() {
  const url = $("#quick").value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return toast("Paste a link that starts with http");
  const btn = $("#quickAdd");
  btn.disabled = true;
  toast("Reading the link…");
  const r = await chrome.runtime.sendMessage({ type: "quick", url }).catch((e) => ({ ok: false, error: e.message }));
  btn.disabled = false;
  if (r?.ok) { $("#quick").value = ""; toast("Added"); } else toast((r?.error || "Could not add").slice(0, 120));
}
$("#quickAdd").addEventListener("click", quickAdd);
$("#quick").addEventListener("keydown", (e) => e.key === "Enter" && quickAdd());

/* ------------------------------------------------------------------ settings */
const save = (k, v) => { st[k] = v; chrome.storage.local.set({ [k]: v }); };

function initSettings() {
  $$("[data-key]").forEach((el) => {
    const k = el.dataset.key;
    if (el.type === "checkbox") el.checked = !!st[k]; else el.value = st[k] ?? "";
    el.addEventListener("change", () => {
      let v = el.type === "checkbox" ? el.checked : el.value;
      if (el.hasAttribute("data-num")) v = +v;
      if (k === "subLang") v = v.trim() || "en";
      if (k === "dir") v = v.trim();
      save(k, v);
    });
  });
  $$('input[name="via"]').forEach((r) => {
    r.checked = r.value === st.via;
    r.addEventListener("change", () => { save("via", r.value); $("#dirRow").hidden = r.value === "chrome"; });
  });
  $("#dirRow").hidden = st.via === "chrome";
  $$("#themeSeg button").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.theme === st.theme);
    b.addEventListener("click", () => {
      save("theme", b.dataset.theme);
      CG.applyTheme(st);
      $$("#themeSeg button").forEach((x) => x.setAttribute("aria-selected", x === b));
    });
  });
  $("#browse").addEventListener("click", async () => {
    try {
      const r = await CG.nativeCall({ action: "pickfolder" }, null, ["folder"]);
      if (r.path) { $("#dir").value = r.path; save("dir", r.path); }
    } catch (e) { toast(e.message.slice(0, 120)); }
  });
}

/* ------------------------------------------------------------------ setup */
const ROWS = [
  { k: "yt-dlp", name: "yt-dlp", why: "Reads links and downloads the media.", pkg: "yt-dlp", need: true },
  { k: "ffmpeg", name: "ffmpeg", why: "Joins video and audio for 1080p and up, and converts to MP3.", pkg: "ffmpeg", need: true },
  { k: "deno", name: "Deno", why: "YouTube needs a JavaScript runtime. Without one, formats go missing.", pkg: "deno", need: true },
  { k: "megacmd", name: "MEGAcmd", why: "Only needed for mega.nz links.", pkg: "megacmd", need: false },
];

function toolRow(r, m) {
  const t = m.tools[r.k];
  let pill, fix = "";
  if (t.ok) pill = `<span class="pill ok">${I("check", 13, 2.6)}${esc(t.version || "Installed")}</span>`;
  else if (r.k === "deno" && m.tools.node.ok) pill = `<span class="pill warn">Using Node instead</span>`;
  else pill = `<span class="pill ${r.need ? "bad" : ""}">${r.need ? "Missing" : "Not installed"}</span>`;
  const missing = !t.ok && !(r.k === "deno" && m.tools.node.ok);
  if (missing || (r.k === "deno" && !t.ok)) {
    const win = navigator.userAgent.includes("Windows");
    const cmd = win ? `winget install --id ${{"yt-dlp":"yt-dlp.yt-dlp","ffmpeg":"Gyan.FFmpeg","deno":"DenoLand.Deno"}[r.pkg] || r.pkg} --exact` : (r.pkg === "megacmd" ? "brew install --cask megacmd" : "brew install " + r.pkg);
    const canInstall = win ? r.pkg !== "megacmd" : !!m.brew;
    fix = canInstall
      ? `<div class="fix inline"><button class="btn sm primary" data-install="${r.pkg}">Install ${win ? "with winget" : "with Homebrew"}</button><code>${cmd}</code></div>`
      : win
        ? `<div class="fix hint">MEGAcmd is optional and must be installed separately on Windows.</div>`
        : `<div class="fix hint">Homebrew is needed first: <code>https://brew.sh</code>, then <code>${cmd}</code></div>`;
  }
  return `<div class="tool" data-pkg="${r.pkg}"><span class="nm">${r.name}</span><span class="rt">${pill}</span><span class="why">${r.why}</span>${fix}</div>`;
}

async function runCheck() {
  $("#tools").innerHTML = `<div class="skel" style="height:56px"></div><div class="skel" style="height:56px"></div>`;
  try {
    const m = await CG.nativeCall({ action: "check" }, null, ["tools"]);
    lastTools = m;
    $("#tools").innerHTML = `<div class="tool"><span class="nm">Helper</span><span class="rt"><span class="pill ok">${I("check", 13, 2.6)}v${esc(m.host)}</span></span><span class="why">Connects your browser to the TurboFetch helper. Python ${esc(m.python)}.</span></div>` + ROWS.map((r) => toolRow(r, m)).join("");
    $("#hostInfo").textContent = `Log: ${m.log.replace(/^\/Users\/[^/]+/, "~")}`;
    $("#openLog").disabled = false;
  } catch (e) {
    lastTools = null;
    $("#tools").innerHTML = `<div class="notice bad">${I("alert")}<div><b>The helper is not installed</b>${esc(e.message)}<br><br>Run the platform installer from the project folder:<pre class="code" style="margin-top:6px">${navigator.userAgent.includes("Windows") ? ".\\build_windows.ps1" : "./install_mac.sh"}</pre>Then fully quit and reopen your browser, and press “Check again”.</div></div>`;
  }
}

const verCmp = (a, b) => {
  const x = a.match(/\d+/g) || [], y = b.match(/\d+/g) || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (+x[i] || 0) - (+y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
};

async function checkUpdate() {
  const box = $("#updState");
  box.innerHTML = `<span class="mute">Checking GitHub…</span>`;
  const installed = lastTools?.tools?.["yt-dlp"]?.version;
  let tag;
  try {
    const r = await fetch("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", { headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 403 || r.status === 429) throw new Error("GitHub’s rate limit was reached. Try again in a few minutes");
    if (!r.ok) throw new Error("GitHub answered " + r.status);
    tag = (await r.json()).tag_name;
  } catch (e) {
    box.innerHTML = `<div class="big">Could not check</div><div class="mute">${esc(e.message)}.</div>`;
    return;
  }
  latestTag = tag;
  if (!installed) { box.innerHTML = `<div class="big">yt-dlp is not installed</div><div class="mute">Latest version is <code>${esc(tag)}</code>. Install it above first.</div>`; $("#doUpd").hidden = true; return; }
  const behind = verCmp(installed, tag) < 0;
  if (behind && latestTag !== notifiedUpdateTag) {
    notifiedUpdateTag = latestTag;
    chrome.notifications.create("bytebridge-update", { type: "basic", iconUrl: "icons/128.png", title: "TurboFetch update available", message: `yt-dlp ${tag} is available (installed ${installed}).` }, () => void chrome.runtime.lastError);
  }
  box.innerHTML = `<div class="big" style="color:var(${behind ? "--warn" : "--ok"})">${behind ? "Update available" : "You’re up to date"}</div><div class="mute">Installed <code>${esc(installed)}</code> · Latest <code>${esc(tag)}</code></div>`;
  $("#doUpd").hidden = !behind;
  $("#navDot").hidden = !behind;
}

async function doUpdate() {
  const btn = $("#doUpd"), log = $("#updLog");
  btn.disabled = true;
  btn.textContent = "Updating…";
  log.hidden = false;
  log.textContent = "";
  try {
    const r = await CG.nativeCall({ action: "update" }, (m) => { if (m.type === "log") { log.textContent += m.line + "\n"; log.scrollTop = log.scrollHeight; } });
    await runCheck();
    await checkUpdate();
    if (r.status !== "done") log.textContent += "\n" + (r.error || "Update failed");
    else if (latestTag && r.after && verCmp(r.after, latestTag) < 0) {
      log.textContent += r.method === "brew"
        ? `\nHomebrew only has ${r.after} so far. It usually trails GitHub by a day or two. Check again later.`
        : `\nStill on ${r.after}. Check again in a moment.`;
    } else toast("yt-dlp updated to " + r.after);
  } catch (e) { log.textContent += "\n" + e.message; }
  btn.disabled = false;
  btn.textContent = "Update now";
}

$("#tools").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-install]");
  if (!b) return;
  const row = b.closest(".tool");
  b.disabled = true;
  b.textContent = "Installing…";
  let log = row.querySelector("pre");
  if (!log) { log = document.createElement("pre"); log.className = "code fix"; log.style.maxHeight = "140px"; row.append(log); }
  try {
    const r = await CG.nativeCall({ action: "install", pkg: b.dataset.install }, (m) => { if (m.type === "log") { log.textContent += m.line + "\n"; log.scrollTop = log.scrollHeight; } });
    if (r.status === "done") { toast("Installed"); return runCheck(); }
    log.textContent += "\n" + (r.error || "Install failed");
  } catch (err) { log.textContent += "\n" + err.message; }
  b.disabled = false;
  b.textContent = "Try again";
});

let setupLoaded = false;
let notifiedUpdateTag = null;
async function loadSetup() {
  if (setupLoaded) return;
  setupLoaded = true;
  await runCheck();
  checkUpdate();
}
$("#recheck").addEventListener("click", async () => { await runCheck(); checkUpdate(); });
$("#chkUpd").addEventListener("click", async () => { if (!lastTools) await runCheck(); checkUpdate(); });
$("#doUpd").addEventListener("click", doUpdate);
$("#openLog").addEventListener("click", () => lastTools && CG.nativeCall({ action: "open", path: lastTools.log }).catch((e) => toast(e.message)));
$("#supportProject").addEventListener("click", () => chrome.tabs.create({ url: DONATION_URL }));

/* ------------------------------------------------------------------ init */
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.jobs) { jobsData = c.jobs.newValue || {}; renderDownloads(); }
});

(async () => {
  st = await CG.getSettings();
  CG.applyTheme(st);
  fillIcons();
  initSettings();
  jobsData = (await chrome.storage.local.get("jobs")).jobs || {};
  renderDownloads();
  route();
  setInterval(renderDownloads, 30000); // keeps "5 min ago" fresh
})();
