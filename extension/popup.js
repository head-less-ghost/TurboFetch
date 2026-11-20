const $ = (s) => document.querySelector(s);
const I = CG.icon;
const esc = CG.esc;
const PRESETS = [["best", "Best", "Highest available"], ["2160", "2160p", "Up to 4K"], ["1440", "1440p", "Up to 1440p"],
  ["1080", "1080p", "Up to Full HD"], ["720", "720p", "Up to 720p"], ["480", "480p", "Up to 480p"], ["360", "360p", "Up to 360p"]];

const S = { st: null, url: "", p: null, tab: "video", vsel: null, asel: null, convert: "mp3", hsel: "1080", pl: false, sub: "", subFmt: "srt", embed: false, busy: false };
let reqId = 0;

function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = Object.assign(document.createElement("div"), { className: "toast", textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2400);
}

/* ---------------------------------------------------------------- loading a link */
async function load(url) {
  const my = ++reqId;
  S.url = url;
  S.p = null;
  $("#notice").textContent = "";
  $("#picker").hidden = true;
  const m = $("#media");
  m.hidden = false;
  m.className = "media";
  m.innerHTML = `<div class="thumb skel"></div><div><div class="skel l1"></div><div class="skel l2"></div><p class="hint" style="margin-top:10px">Reading available formats…</p></div>`;
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "probe", url }); } catch (e) { r = { ok: false, error: e.message }; }
  if (my !== reqId) return;
  if (!r?.ok) return showError(r || {});
  S.p = r.data;
  initChoices();
  render();
}

function showError(r) {
  $("#media").hidden = true;
  const msg = r.error || "Something went wrong.";
  let title = "Could not read this link", body = msg, btn = "";
  if (r.code === "unsupported") {
    title = "No downloadable media here";
    body = "Open a page with a video, or paste a direct link above.";
  } else if (/helper|install_mac|build_windows|forbidden|yt-dlp not found|missing-ytdlp/i.test(msg + (r.code || ""))) {
    title = "The helper needs setting up";
    btn = `<button class="btn sm" data-act="setup">Open setup</button>`;
  } else if (/sign in to confirm|not a bot|use --cookies|age-restricted|confirm your age|members-only/i.test(msg)) {
    title = "YouTube wants a signed-in browser";
    body = "Turn on “Use browser cookies” in Settings, then try again.";
    btn = `<button class="btn sm" data-act="settings">Open settings</button>`;
  }
  $("#notice").innerHTML = `<div class="notice bad">${I("alert")}<div><b>${esc(title)}</b>${esc(body.length > 220 ? body.slice(0, 220) + "…" : body)}${btn ? "<br>" + btn : ""}</div></div>`;
}

function initChoices() {
  const p = S.p, st = S.st;
  const ch = CG.defaultChoice(p, st);
  S.vsel = ch.kind === "video" ? ch.itemId : null;
  S.asel = (p.audio || [])[0]?.id || null;
  S.tab = st.defaultQuality === "audio" && p.kind !== "direct" && p.kind !== "mega" ? "audio" : "video";
  S.hsel = PRESETS.some(([k]) => k === st.defaultQuality) ? st.defaultQuality : "1080";
  S.pl = p.kind === "playlist";
  S.sub = "";
  if (!p.has_js_runtime && /youtube/i.test(p.site || "")) {
    $("#notice").innerHTML = `<div class="notice">${I("alert")}<div><b>Install Deno for full YouTube support</b>Without it, some formats may be missing. <br><button class="btn sm" data-act="setup">Fix in Setup</button></div></div>`;
  }
}

/* ---------------------------------------------------------------- rendering */
function render() {
  renderMedia();
  renderTabs();
  renderPanel();
  $("#picker").hidden = false;
}

function renderMedia() {
  const p = S.p;
  const icon = p.kind === "playlist" ? "playlist" : p.kind === "video" ? "video" : "file";
  const thumb = p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" referrerpolicy="no-referrer">` : I(icon, 28);
  const dur = p.kind === "video" && p.duration ? `<span class="dur">${CG.fmtDur(p.duration)}</span>` : "";
  const sub = [p.uploader, p.kind === "playlist" ? `${p.count || "?"} videos` : p.kind === "direct" ? CG.fmtBytes(p.size) : "", p.site].filter(Boolean).join(" · ");
  const live = p.is_live ? ` <span class="pill warn">Live</span>` : "";
  const m = $("#media");
  m.hidden = false;
  m.className = "media";
  m.innerHTML = `<div class="thumb">${thumb}${dur}</div><div style="min-width:0"><h2>${esc(p.title || CG.host(S.url))}</h2><div class="sub">${esc(sub)}${live}</div></div>`;
}

function renderTabs() {
  const p = S.p;
  const tabs = $("#tabs");
  if (p.kind === "direct" || p.kind === "mega") { tabs.hidden = true; return; }
  tabs.hidden = false;
  const list = [["video", "Video", "video"], ["audio", "Audio", "music"]];
  if (p.kind === "video") list.push(["subs", "Subtitles", "cc"]);
  tabs.innerHTML = list.map(([k, l, ic]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${I(ic, 15)}${l}</button>`).join("");
}

function rung({ id, res, tags = [], size, pct, sel }) {
  const t = tags.filter(Boolean).map((x) => `<span class="tag ${x.cls || ""}">${esc(x.t || x)}</span>`).join("");
  return `<button class="rung" role="radio" aria-checked="${sel}" data-id="${esc(id)}"><span class="res">${esc(res)}</span><span class="tags">${t}</span><span class="size num">${size ? "~" + CG.fmtBytes(size) : ""}</span>${pct != null ? `<span class="szbar" style="width:${pct}%"></span>` : ""}</button>`;
}

const isPlaylist = () => S.p.kind === "playlist" || S.pl;
const chromeMode = () => S.st.via === "chrome" && S.tab !== "subs";
const videoList = () => (chromeMode() ? S.p.single : S.p.video) || [];
const vid = (v) => v.key || v.id;

function renderPanel() {
  const p = S.p;
  let html = "", opts = "";

  if (p.kind === "direct" || p.kind === "mega") {
    html = `<div class="ladder">${rung({ id: "file", res: "File", tags: [p.kind === "mega" ? "via MEGAcmd" : "Original"], size: p.size, sel: true })}</div>`;
  } else if (S.tab === "video") {
    if (isPlaylist()) {
      html = `<div class="ladder">${PRESETS.map(([k, l, d]) => rung({ id: k, res: l, tags: [d], sel: S.hsel === k })).join("")}</div>`;
    } else {
      const list = videoList();
      if (!list.some((v) => vid(v) === S.vsel)) S.vsel = list[0] ? vid(list[0]) : "__best";
      const max = Math.max(...list.map((v) => v.size || 0), 1);
      html = `<div class="ladder">` + (list.length
        ? list.map((v) => rung({ id: vid(v), res: v.label, tags: [v.codec, (v.ext || "").toUpperCase(), v.hdr && { t: v.hdr, cls: "hdr" }], size: v.size, pct: v.size ? (v.size / max) * 100 : null, sel: vid(v) === S.vsel })).join("")
        : rung({ id: "__best", res: "Best", tags: ["Auto"], sel: true })) + `</div>`;
    }
    opts += playlistToggle() + subtitleRow() + modeHint();
  } else if (S.tab === "audio") {
    if (isPlaylist()) {
      html = `<div class="empty-line">Every video in the playlist is saved as audio.</div>`;
    } else {
      const list = S.p.audio || [];
      if (!list.some((a) => a.id === S.asel)) S.asel = list[0]?.id || "__best";
      const max = Math.max(...list.map((a) => a.size || 0), 1);
      html = `<div class="ladder">` + (list.length
        ? list.map((a) => rung({ id: a.id, res: a.abr ? a.abr + " kbps" : "Best", tags: [a.label], size: a.size, pct: a.size ? (a.size / max) * 100 : null, sel: a.id === S.asel })).join("")
        : rung({ id: "__best", res: "Best", tags: ["Extracted from video"], sel: true })) + `</div>`;
    }
    const forced = chromeMode();
    const conv = forced ? "original" : S.convert;
    opts += `<div class="row"><label>Save as</label><div class="seg" id="convSeg" style="min-width:210px">${[["mp3", "MP3"], ["m4a", "M4A"], ["original", "Original"]]
      .map(([k, l]) => `<button type="button" role="radio" data-conv="${k}" aria-checked="${conv === k}" ${forced && k !== "original" ? "disabled" : ""}>${l}</button>`).join("")}</div></div>`;
    opts += playlistToggle() + modeHint();
  } else {
    html = subsPanel();
  }
  $("#panel").innerHTML = html;
  $("#opts").innerHTML = opts;
  renderGo();
}

function playlistToggle() {
  if (!(S.p.kind === "video" && S.p.in_playlist)) return "";
  return `<label class="switch"><input type="checkbox" id="plSw" ${S.pl ? "checked" : ""}><span class="sw"></span><span>Download the whole playlist</span></label>`;
}

function modeHint() {
  if (!chromeMode() || S.p.kind === "mega") return "";
  return `<p class="hint">Link mode: Chrome downloads one ready-made file, so YouTube tops out around 360–720p. Switch to the helper in Settings for 1080p and 4K.</p>`;
}

function subOptions(withNone) {
  const p = S.p;
  const opt = (k, s) => `<option value="${k}:${esc(s.code)}" ${S.sub === `${k}:${s.code}` ? "selected" : ""}>${esc(s.name)} (${esc(s.code)})</option>`;
  return (withNone ? `<option value="">None</option>` : "")
    + (p.subs?.length ? `<optgroup label="Written by the uploader">${p.subs.map((s) => opt("m", s)).join("")}</optgroup>` : "")
    + (p.auto?.length ? `<optgroup label="Auto-generated">${p.auto.map((s) => opt("a", s)).join("")}</optgroup>` : "");
}

function subtitleRow() {
  const p = S.p;
  if (!(p.subs?.length || p.auto?.length) || chromeMode()) return "";
  let out = `<div class="row"><label for="subSel">Subtitles</label><select id="subSel" class="plain">${subOptions(true)}</select></div>`;
  if (S.sub) out += `<label class="switch"><input type="checkbox" id="embedSw" ${S.embed ? "checked" : ""}><span class="sw"></span><span>Embed in the video file</span></label>`;
  return out;
}

function defaultSub() {
  const p = S.p, l = S.st.subLang;
  const m = (p.subs || []).find((s) => s.code === l || s.code.startsWith(l + "-"));
  if (m) return "m:" + m.code;
  const a = (p.auto || []).find((s) => s.code === l + "-orig") || (p.auto || []).find((s) => s.code === l);
  if (a) return "a:" + a.code;
  if (p.subs?.length) return "m:" + p.subs[0].code;
  if (p.auto?.length) return "a:" + p.auto[0].code;
  return "";
}

function subsPanel() {
  const p = S.p;
  if (!(p.subs?.length || p.auto?.length)) return `<div class="empty-line">This video has no subtitles.</div>`;
  if (!S.sub) S.sub = defaultSub();
  return `<div class="sub-tab"><div class="row"><label for="subSel">Language</label><select id="subSel" class="plain" style="max-width:250px">${subOptions(false)}</select></div>
    <div class="row"><label>Format</label><div class="seg" id="fmtSeg" style="min-width:150px">${[["srt", "SRT"], ["vtt", "VTT"]].map(([k, l]) => `<button type="button" role="radio" data-fmt="${k}" aria-checked="${S.subFmt === k}">${l}</button>`).join("")}</div></div>
    <p class="hint">Saved as a separate file next to your downloads. SRT works in almost every player.</p></div>`;
}

function currentItem() {
  if (S.tab === "video") return videoList().find((v) => vid(v) === S.vsel);
  if (S.tab === "audio") return (S.p.audio || []).find((a) => a.id === S.asel);
}

function renderGo() {
  const p = S.p;
  const cm = chromeMode() && p.kind !== "mega";
  const verb = cm ? "Send to Chrome" : "Download";
  let label = verb, ic = "download";
  if (S.tab === "subs" && p.kind === "video") { label = "Download subtitles"; ic = "cc"; }
  else if (p.kind === "direct" || p.kind === "mega") label = `${verb}${p.size ? " · " + CG.fmtBytes(p.size) : ""}`;
  else if (isPlaylist()) label = `${verb} playlist`;
  else {
    const it = currentItem();
    const name = S.tab === "audio" ? (cm ? it?.label : S.convert === "original" ? it?.label : S.convert.toUpperCase()) : it?.label;
    label = `${verb}${name ? " " + name : ""}${it?.size ? " · ~" + CG.fmtBytes(it.size) : ""}`;
  }
  $("#goIc").innerHTML = I(ic, 17, 2.2);
  $("#goLabel").textContent = label;
  $("#copy").hidden = !(cm && !isPlaylist());
  $("#go").disabled = S.busy || (S.tab === "subs" && !S.sub);
}

/* ---------------------------------------------------------------- choices -> job */
function subChoice() {
  if (!S.sub) return null;
  const k = S.sub.slice(0, 1), code = S.sub.slice(2);
  const list = k === "m" ? S.p.subs : S.p.auto;
  return { code, auto: k === "a", name: list?.find((x) => x.code === code)?.name || code, format: S.subFmt, embed: S.embed };
}

function choice() {
  const p = S.p;
  if (p.kind === "direct" || p.kind === "mega") return { kind: "file" };
  if (S.tab === "subs") return { kind: "subs", subs: subChoice() };
  const h = S.hsel === "best" ? null : +S.hsel;
  if (S.tab === "audio") return { kind: "audio", itemId: S.asel, convert: S.convert, playlist: isPlaylist(), height: h };
  return { kind: "video", itemId: S.vsel, subs: subChoice(), playlist: isPlaylist(), height: h };
}

async function go(later) {
  if (!S.p || S.busy) return;
  S.busy = true;
  renderGo();
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "enqueue", url: S.url, choice: choice(), later }); } catch (e) { r = { ok: false, error: e.message }; }
  S.busy = false;
  renderGo();
  toast(r?.ok ? (later ? "Saved for later. Start it from the manager." : "Added to your downloads") : r?.error || "Could not add");
}

async function copyLink() {
  try {
    if (S.p.kind === "direct") await navigator.clipboard.writeText(S.url);
    else {
      toast("Getting the link…");
      const fmt = S.tab === "audio" ? (S.asel === "__best" ? "ba/b" : S.asel) : S.vsel === "__best" ? "b" : S.vsel;
      const r = await CG.nativeCall({ action: "geturl", url: S.url, fmt, cookies: S.st.cookies }, null, ["link"]);
      if (r.error) return toast(r.error.slice(0, 100));
      await navigator.clipboard.writeText(r.url);
    }
    toast("Direct link copied");
  } catch (e) { toast(e.message.slice(0, 100)); }
}

/* ---------------------------------------------------------------- events */
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  S.tab = b.dataset.tab;
  renderTabs();
  renderPanel();
});
$("#panel").addEventListener("click", (e) => {
  const b = e.target.closest(".rung");
  if (b) {
    if (S.tab === "video") { isPlaylist() ? (S.hsel = b.dataset.id) : (S.vsel = b.dataset.id); }
    else if (S.tab === "audio") S.asel = b.dataset.id;
    renderPanel();
  }
  const f = e.target.closest("[data-fmt]");
  if (f) { S.subFmt = f.dataset.fmt; renderPanel(); }
});
$("#panel").addEventListener("change", (e) => { if (e.target.id === "subSel") { S.sub = e.target.value; renderGo(); } });
$("#opts").addEventListener("change", (e) => {
  if (e.target.id === "subSel") { S.sub = e.target.value; renderPanel(); }
  if (e.target.id === "embedSw") S.embed = e.target.checked;
  if (e.target.id === "plSw") { S.pl = e.target.checked; renderPanel(); }
});
$("#opts").addEventListener("click", (e) => {
  const c = e.target.closest("[data-conv]");
  if (c && !c.disabled) { S.convert = c.dataset.conv; renderPanel(); }
});
$("#go").addEventListener("click", () => go(false));
$("#later").addEventListener("click", () => go(true));
$("#copy").addEventListener("click", copyLink);

$("#notice").addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]")?.dataset.act;
  if (a === "setup" || a === "settings") { CG.openManager(a); window.close(); }
});
const openMgr = () => { CG.openManager("downloads"); window.close(); };
$("#openMgr").addEventListener("click", openMgr);
$("#all").addEventListener("click", openMgr);
$("#openSet").addEventListener("click", () => { CG.openManager("settings"); window.close(); });

const urlBox = $("#url");
const valid = (v) => /^https?:\/\/\S+$/i.test(v);
let typing;
urlBox.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => { const v = urlBox.value.trim(); if (valid(v) && v !== S.url) load(v); }, 500);
});
urlBox.addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = urlBox.value.trim(); if (valid(v)) load(v); } });
$("#paste").addEventListener("click", async () => {
  try {
    const v = (await navigator.clipboard.readText()).trim();
    urlBox.value = v;
    if (valid(v)) load(v);
  } catch { urlBox.focus(); }
});

/* ---------------------------------------------------------------- recent activity */
const jobsBox = $("#jobs");
JobsUI.bind(jobsBox, toast);
async function renderJobs() {
  const { jobs = {} } = await chrome.storage.local.get("jobs");
  const all = Object.values(jobs);
  const active = (j) => (j.status === "running" || j.status === "queued" ? 0 : 1);
  const list = all.sort((a, b) => active(a) - active(b) || b.updated - a.updated).slice(0, 3);
  JobsUI.sync(jobsBox, list);
  $("#empty").hidden = list.length > 0;
  const n = all.filter((j) => j.status === "running" || j.status === "queued").length;
  $("#openMgr").innerHTML = I("list") + (n ? `<span class="count">${n}</span>` : "");
}
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  if (c.jobs) renderJobs();
  if (c.theme) CG.getSettings().then(CG.applyTheme);
});

/* ---------------------------------------------------------------- init */
(async () => {
  S.st = await CG.getSettings();
  CG.applyTheme(S.st);
  S.convert = S.st.audioFormat;
  S.subFmt = S.st.subFormat;
  S.embed = S.st.subEmbed;
  $("#linkIc").innerHTML = I("link", 16);
  $("#openSet").innerHTML = I("gear");
  $("#later").innerHTML = I("clock", 19);
  $("#copy").innerHTML = I("copy", 19);
  $("#emptyIc").innerHTML = I("download", 26);
  renderJobs();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const u = tab?.url || "";
  if (/^https?:\/\//i.test(u) && !/^https?:\/\/(chrome\.google\.com|chromewebstore\.google\.com)/i.test(u)) {
    urlBox.value = u;
    load(u);
  } else urlBox.focus();
})();
