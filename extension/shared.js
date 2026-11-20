/* shared.js: loaded by the popup, the manager page, the service worker and the YouTube content script. */
var CG = (() => {
  const HOST = "com.bytebridge.host";

  const DEFAULTS = {
    via: "disk",            // "disk" = helper saves to a folder, "chrome" = send link to Chrome downloads
    dir: "",
    defaultQuality: "1080", // best | 2160 | 1440 | 1080 | 720 | 480 | audio
    audioFormat: "mp3",     // mp3 | m4a | original
    compat: true,           // prefer H.264 + AAC so files open in QuickTime
    maxParallel: 2,
    subLang: "en",
    subFormat: "srt",
    subEmbed: false,
    cookies: "",            // "" or a browser name for yt-dlp --cookies-from-browser
    template: "",
    notify: true,
    ytButton: true,
    theme: "auto",          // auto | light | dark
  };

  const getSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });

  /* ---------- formatting ---------- */
  const fmtBytes = (n) => {
    if (n == null || isNaN(n)) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
  };
  const fmtDur = (s) => {
    if (!s) return "";
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
  };
  const fmtSpeed = (b) => (b ? fmtBytes(b) + "/s" : "");
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u || ""; } };
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return new Date(t).toLocaleDateString();
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- icons (stroke icons, 24 grid) ---------- */
  const P = {
    download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="M7 4.8v14.4a.6.6 0 0 0 .9.5l11.4-7.2a.6.6 0 0 0 0-1L7.9 4.3a.6.6 0 0 0-.9.5z"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.1"/>',
    cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    video: '<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 10 6-3v10l-6-3z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    playlist: '<path d="M3 6h12M3 12h12M3 18h7M17 14v6l5-3z"/>',
  };
  const icon = (n, s = 18, w = 1.9) =>
    `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;

  const applyTheme = (st) => {
    const t = st.theme;
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  };

  /* ---------- links to this extension's pages ---------- */
  const openManager = (hash = "downloads") => chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") + "#" + hash });

  /* ---------- talking to the native helper ---------- */
  function friendlyHostError(err) {
    if (/not found/i.test(err)) return "The TurboFetch helper is not installed. Run build_windows.ps1 on Windows or install_mac.sh on macOS, then restart the browser.";
    if (/forbidden/i.test(err)) return "The browser blocked the helper. Re-run the platform installer so its manifest matches this extension ID.";
    return err || "The helper stopped unexpectedly.";
  }
  /** Opens a one-shot native connection. onMsg(msg) is called for every message; resolves with the last. */
  function nativeCall(payload, onMsg, doneTypes = ["done"]) {
    return new Promise((resolve, reject) => {
      let port;
      try { port = chrome.runtime.connectNative(HOST); } catch (e) { return reject(new Error(friendlyHostError(e.message))); }
      let finished = false;
      port.onMessage.addListener((m) => {
        onMsg && onMsg(m);
        if (doneTypes.includes(m.type)) { finished = true; resolve(m); try { port.disconnect(); } catch {} }
      });
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message;
        if (!finished) reject(new Error(friendlyHostError(err)));
      });
      port.postMessage(payload);
    });
  }

  /* ---------- turning a user's choice into a job ---------- */
  const heightSel = (h) => `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;

  function subsSpec(p, c, st) {
    const s = c.subs;
    if (!s || !s.code) return null;
    return { langs: [s.code], auto: !!s.auto, format: s.format || st.subFormat, embed: !!s.embed };
  }

  function makeJob(p, c, st) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      id, url: p.url, title: p.title || host(p.url), thumb: p.thumbnail || null, uploader: p.uploader || null,
      duration: p.duration || null, site: p.site || host(p.url), kind: c.kind, tool: "yt-dlp", status: "queued",
      pct: 0, created: Date.now(), updated: Date.now(), spec: {}, label: "",
    };
    const chromeMode = st.via === "chrome" && c.kind !== "subs";

    if (p.kind === "mega") {
      return { ...job, tool: "mega", kind: "file", label: "MEGA file", spec: {} };
    }
    if (p.kind === "direct") {
      return { ...job, tool: chromeMode ? "chrome" : "direct", kind: "file", label: "Direct file", size: p.size,
        spec: { filename: p.filename, expected: p.size, fmt: null } };
    }

    if (c.kind === "subs") {
      job.label = `Subtitles · ${c.subs.name || c.subs.code}`;
      job.spec = { subs: subsSpec(p, c, st) };
      return job;
    }

    if (p.kind === "playlist" || c.playlist) {
      const h = c.height;
      job.spec = { playlist: true, fmt: c.kind === "audio" ? "ba/b" : (h ? heightSel(h) : "bv*+ba/b"),
        convert: c.convert || st.audioFormat, subs: subsSpec(p, c, st) };
      job.label = (p.kind === "playlist" ? `Playlist · ${p.count || "?"} videos` : "Playlist") + (c.kind === "audio" ? " · audio" : h ? ` · up to ${h}p` : " · best");
      return job;
    }

    if (c.kind === "audio") {
      const item = (p.audio || []).find((a) => a.id === c.itemId);
      const convert = chromeMode ? "original" : (c.convert || st.audioFormat);
      job.spec = { fmt: item ? item.id : "ba/b", convert, expected: item?.size || null };
      job.label = (convert === "original" ? (item?.label || "Audio") : convert.toUpperCase()) + (item?.abr ? ` · ${item.abr} kbps` : "");
      job.size = item?.size || null;
      if (chromeMode) job.tool = "chrome";
      return job;
    }

    // video
    const list = chromeMode ? (p.single || []) : (p.video || []);
    const item = list.find((v) => v.key === c.itemId || v.id === c.itemId);
    if (item) {
      const fb = heightSel(item.height);
      const fmt = item.merge ? `${item.id}+${p.audio_pick || "ba"}/${fb}` : `${item.id}/${fb}`;
      job.spec = { fmt: chromeMode ? item.id : fmt, expected: item.size || null, subs: chromeMode ? null : subsSpec(p, c, st) };
      job.label = [item.label, item.codec].filter(Boolean).join(" · ");
      job.size = item.size || null;
    } else {
      job.spec = { fmt: chromeMode ? "b" : "bv*+ba/b", subs: chromeMode ? null : subsSpec(p, c, st) };
      job.label = "Best available";
    }
    if (chromeMode) job.tool = "chrome";
    return job;
  }

  /** The choice made by one click on the YouTube button / context menu / quick-add. */
  function defaultChoice(p, st) {
    const q = st.defaultQuality;
    if (p.kind === "playlist") return q === "audio" ? { kind: "audio" } : { kind: "video", height: q === "best" ? null : +q };
    if (q === "audio") {
      const a = (p.audio || [])[0];
      return { kind: "audio", itemId: a?.id, convert: st.audioFormat };
    }
    const list = st.via === "chrome" ? (p.single || []) : (p.video || []);
    const cap = q === "best" ? Infinity : +q;
    const pick = list.find((v) => v.height <= cap) || list[list.length - 1];
    return { kind: "video", itemId: pick?.key || pick?.id };
  }

  /** YouTube watch / shorts URL for the page we are on, without playlist or timestamp noise. */
  function youtubeUrl(href) {
    try {
      const u = new URL(href);
      if (u.pathname === "/watch" && u.searchParams.get("v")) return `https://www.youtube.com/watch?v=${u.searchParams.get("v")}`;
      const m = u.pathname.match(/^\/shorts\/([\w-]+)/);
      if (m) return `https://www.youtube.com/shorts/${m[1]}`;
    } catch {}
    return null;
  }

  return { HOST, DEFAULTS, getSettings, fmtBytes, fmtDur, fmtSpeed, host, ago, esc, icon, openManager,
    applyTheme, nativeCall, friendlyHostError, makeJob, defaultChoice, youtubeUrl, heightSel };
})();
