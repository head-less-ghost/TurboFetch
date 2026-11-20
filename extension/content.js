/* content.js: the small download button on YouTube watch pages and Shorts. */
(() => {
  if (window.__cgButton) return;
  window.__cgButton = true;
  const I = CG.icon;
  let st = null;
  let navAt = Date.now();

  const send = (m) => chrome.runtime.sendMessage(m).catch((e) => ({ ok: false, error: /context invalidated/i.test(e.message) ? "TurboFetch was updated. Reload this page." : e.message }));
  const isDark = () => document.documentElement.hasAttribute("dark");

  const CSS = `
    :host { all: initial; display: inline-flex; vertical-align: middle; }
    :host(.fab) { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; }
    * { box-sizing: border-box; }
    .grp { --bg: rgba(0,0,0,.05); --hover: rgba(0,0,0,.1); --fg: #0f0f0f; --sep: rgba(0,0,0,.12); --acc: #3d5afe;
      display: inline-flex; align-items: stretch; height: 36px; margin-left: 8px; border-radius: 18px; background: var(--bg); color: var(--fg);
      font: 500 14px/1 Roboto, Arial, sans-serif; overflow: hidden; white-space: nowrap; }
    .grp.dark { --bg: rgba(255,255,255,.1); --hover: rgba(255,255,255,.2); --fg: #f1f1f1; --sep: rgba(255,255,255,.18); --acc: #8da0ff; }
    :host(.fab) .grp { height: 44px; margin: 0; border-radius: 22px; background: var(--acc); color: #fff; --hover: rgba(255,255,255,.18); --sep: rgba(255,255,255,.3); box-shadow: 0 6px 24px rgba(0,0,0,.35); }
    :host(.fab) .grp.dark { background: #3d5afe; }
    button { all: unset; display: inline-flex; align-items: center; gap: 7px; padding: 0 14px; cursor: pointer; }
    button:hover { background: var(--hover); }
    button:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
    .main .ic { color: var(--acc); } :host(.fab) .main .ic { color: #fff; }
    .caret { padding: 0 9px 0 7px; border-left: 1px solid var(--sep); }
    .busy .main { opacity: .7; pointer-events: none; }
    .spin { width: 15px; height: 15px; border: 2px solid var(--sep); border-top-color: currentColor; border-radius: 50%; animation: r .7s linear infinite; }
    @keyframes r { to { transform: rotate(360deg); } }`;

  const MENU_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .menu { --bg: #fff; --fg: #0f0f0f; --mute: #606060; --line: #e5e5e5; --hover: #f2f2f2; --acc: #3d5afe;
      position: fixed; z-index: 2147483001; width: 300px; max-height: min(70vh, 520px); overflow-y: auto; padding: 6px; border-radius: 14px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: 0 12px 40px rgba(0,0,0,.28); font: 14px/1.3 Roboto, Arial, sans-serif; }
    .menu.dark { --bg: #212121; --fg: #f1f1f1; --mute: #aaa; --line: #3a3a3a; --hover: #333; --acc: #8da0ff; }
    h4 { margin: 8px 10px 4px; font: 600 12px/1 Roboto, Arial, sans-serif; color: var(--mute); }
    .it { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 9px 10px; border-radius: 9px; cursor: pointer; }
    .it:hover, .it:focus-visible { background: var(--hover); }
    .it b { font-weight: 600; } .it small { color: var(--mute); font-size: 12px; }
    .it .l { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
    .msg { padding: 14px 12px; color: var(--mute); }
    .foot { border-top: 1px solid var(--line); margin-top: 6px; padding-top: 4px; }
    .toast { position: fixed; z-index: 2147483002; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 10px 16px; border-radius: 10px; background: #111; color: #fff; font: 500 14px Roboto, Arial, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
    .skel { height: 14px; margin: 12px 10px; border-radius: 6px; background: linear-gradient(100deg, var(--line) 30%, var(--hover) 50%, var(--line) 70%) 0 0 / 200% 100%; animation: sh 1.2s linear infinite; }
    @keyframes sh { to { background-position: -200% 0; } }`;

  /* ---------------- the button ---------------- */
  const btnHost = document.createElement("div");
  btnHost.id = "bytebridge-btn";
  const root = btnHost.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style><div class="grp"><button class="main" title="Download at your default quality">${I("download", 17, 2.2)}<span>Download</span></button><button class="caret" title="Choose quality, audio or subtitles" aria-haspopup="menu">${I("chevron", 16, 2.2)}</button></div>`;
  const grp = root.querySelector(".grp");
  const mainBtn = root.querySelector(".main");
  const caret = root.querySelector(".caret");

  /* ---------------- the menu ---------------- */
  const menuHost = document.createElement("div");
  menuHost.id = "bytebridge-menu";
  const mroot = menuHost.attachShadow({ mode: "open" });
  let menuOpen = false;

  function toast(msg) {
    mroot.querySelector(".toast")?.remove();
    const t = Object.assign(document.createElement("div"), { className: "toast", textContent: msg });
    mroot.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  const closeMenu = () => { menuOpen = false; mroot.querySelector(".menu")?.remove(); };

  function openMenu() {
    closeMenu();
    menuOpen = true;
    const url = CG.youtubeUrl(location.href);
    mroot.innerHTML = `<style>${MENU_CSS}</style><div class="menu ${isDark() ? "dark" : ""}" role="menu"><div class="skel"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:85%"></div></div>`;
    placeMenu();
    send({ type: "probe", url }).then((r) => {
      if (!menuOpen) return;
      const menu = mroot.querySelector(".menu");
      if (!r?.ok) {
        menu.innerHTML = `<div class="msg">${CG.esc((r?.error || "Could not read this video").slice(0, 200))}</div><div class="foot"><button class="it" data-open="setup"><b>Open setup</b></button></div>`;
      } else fillMenu(menu, r.data);
      placeMenu();
    });
  }

  function fillMenu(menu, p) {
    const via = st?.via;
    const rows = [];
    const item = (title, sub, choice) => {
      const i = rows.length;
      rows.push(choice);
      return `<button class="it" role="menuitem" data-i="${i}"><span class="l"><b>${CG.esc(title)}</b><small>${CG.esc(sub || "")}</small></span><small>${choice._size ? "~" + CG.fmtBytes(choice._size) : ""}</small></button>`;
    };
    let html = "";
    const vids = (via === "chrome" ? p.single : p.video) || [];
    if (vids.length) {
      html += `<h4>Video</h4>` + vids.map((v) => item(v.label, [v.codec, v.hdr].filter(Boolean).join(" · "), { _size: v.size, kind: "video", itemId: v.key || v.id })).join("");
    } else html += `<h4>Video</h4>` + item("Best available", "", { kind: "video", itemId: "__best" });
    const a = p.audio?.[0];
    html += `<h4>Audio</h4>`;
    if (via === "chrome") html += item(a ? `${a.label}${a.abr ? " · " + a.abr + " kbps" : ""}` : "Best audio", "original stream", { _size: a?.size, kind: "audio", itemId: a?.id });
    else html += item("MP3", "converted", { _size: a?.size, kind: "audio", itemId: a?.id, convert: "mp3" }) + item("M4A", "AAC", { _size: a?.size, kind: "audio", itemId: a?.id, convert: "m4a" });
    const subs = [...(p.subs || []).slice(0, 5).map((s) => ({ ...s, auto: false })), ...(p.auto || []).filter((s) => s.code.endsWith("-orig")).map((s) => ({ ...s, auto: true }))].slice(0, 6);
    if (subs.length) {
      html += `<h4>Subtitles</h4>` + subs.map((s) => item(s.name, s.auto ? "auto-generated" : "SRT", { kind: "subs", subs: { code: s.code, auto: s.auto, name: s.name, format: st?.subFormat || "srt", embed: !!st?.subEmbed } })).join("");
    }
    html += `<div class="foot"><button class="it" data-open="downloads"><b>Open download manager</b></button></div>`;
    menu.innerHTML = html;
    menu._rows = rows;
  }

  mroot.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    if (open) { closeMenu(); return send({ type: "openManager", hash: open.dataset.open }); }
    const it = e.target.closest("[data-i]");
    if (!it) return;
    const choice = { ...mroot.querySelector(".menu")._rows[+it.dataset.i] };
    delete choice._size;
    closeMenu();
    toast("Adding…");
    const r = await send({ type: "enqueue", url: CG.youtubeUrl(location.href), choice });
    toast(r?.ok ? "Added to TurboFetch" : (r?.error || "Could not add").slice(0, 120));
  });

  function placeMenu() {
    const menu = mroot.querySelector(".menu");
    if (!menu) return;
    const r = grp.getBoundingClientRect();
    const w = 300, h = menu.offsetHeight;
    let left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  addEventListener("click", (e) => { if (menuOpen && !e.composedPath().some((n) => n === menuHost || n === btnHost)) closeMenu(); }, true);
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  addEventListener("resize", placeMenu);

  caret.addEventListener("click", (e) => { e.stopPropagation(); menuOpen ? closeMenu() : openMenu(); });
  mainBtn.addEventListener("click", async () => {
    const url = CG.youtubeUrl(location.href);
    if (!url) return;
    closeMenu();
    grp.classList.add("busy");
    const label = mainBtn.querySelector("span");
    label.textContent = "Reading…";
    const r = await send({ type: "quick", url });
    grp.classList.remove("busy");
    label.textContent = "Download";
    toast(r?.ok ? "Added to TurboFetch" : (r?.error || "Could not add").slice(0, 140));
  });

  /* ---------------- placing the button ---------------- */
  const ACTION_BAR = ["ytd-watch-metadata #top-level-buttons-computed", "#actions-inner #top-level-buttons-computed", "#top-level-buttons-computed"];

  function place() {
    const url = CG.youtubeUrl(location.href);
    if (!st?.ytButton || !url) { btnHost.remove(); menuHost.remove(); closeMenu(); return; }
    if (!menuHost.isConnected) document.documentElement.append(menuHost);
    grp.classList.toggle("dark", isDark());
    const shorts = location.pathname.startsWith("/shorts");
    const bar = !shorts && ACTION_BAR.map((s) => document.querySelector(s)).find(Boolean);
    if (bar) {
      btnHost.classList.remove("fab");
      if (btnHost.parentElement !== bar) bar.append(btnHost);
    } else if (shorts || Date.now() - navAt > 4000) {
      btnHost.classList.add("fab");
      if (btnHost.parentElement !== document.body) document.body.append(btnHost);
    } else {
      btnHost.remove(); // give the page a moment to draw its own action bar
      setTimeout(place, 4200 - (Date.now() - navAt));
    }
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; place(); }, 600);
  };

  const onNav = () => { navAt = Date.now(); closeMenu(); schedule(); };
  document.addEventListener("yt-navigate-start", onNav);
  document.addEventListener("yt-navigate-finish", onNav);
  addEventListener("popstate", onNav);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });

  CG.getSettings().then((s) => { st = s; place(); });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    CG.getSettings().then((s) => { st = s; place(); });
  });
})();
