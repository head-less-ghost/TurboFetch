/* jobs-ui.js: renders download cards for the popup and the manager and updates them in place. */
var JobsUI = (() => {
  const I = CG.icon;
  const KIND_ICON = { audio: "music", subs: "cc", file: "file", video: "video" };

  function statLine(j) {
    const pct = Math.round(j.pct || 0);
    const size = j.size ? CG.fmtBytes(j.size) : "";
    switch (j.status) {
      case "running": {
        const bits = [];
        if (j.speed) bits.push(CG.fmtSpeed(j.speed));
        if (j.eta) bits.push(CG.fmtDur(j.eta) + " left");
        const main = j.stage && j.stage !== "Downloading" && j.stage !== "Starting" ? j.stage : j.stage === "Starting" ? "Starting…" : pct + "%";
        return [main, bits.join(" · ")];
      }
      case "queued": return ["Waiting in queue", ""];
      case "paused": return [j.stage === "Saved for later" ? "Saved for later" : j.stage === "Interrupted" ? `Interrupted at ${pct}%` : `Paused at ${pct}%`, ""];
      case "done": return [j.tool === "chrome" ? "Sent to Chrome downloads" : "Saved", [size, j.finished ? CG.ago(j.finished) : ""].filter(Boolean).join(" · ")];
      case "error": return [j.error || "Failed", ""];
      case "canceled": return ["Canceled", ""];
      default: return ["", ""];
    }
  }

  function actions(j) {
    const b = (op, ic, title, cls = "") => `<button class="iconbtn ${cls}" data-op="${op}" title="${title}" aria-label="${title}">${I(ic, 16)}</button>`;
    const canPause = j.tool !== "mega" && j.tool !== "chrome";
    switch (j.status) {
      case "running": return (canPause ? b("pause", "pause", "Pause") : "") + b("cancel", "x", "Cancel", "danger");
      case "queued": return (canPause ? b("pause", "pause", "Hold") : "") + b("cancel", "x", "Cancel", "danger");
      case "paused": return b("resume", "play", "Resume") + b("cancel", "x", "Cancel and delete partial file", "danger");
      case "done": return (j.tool === "chrome" ? "" : b("reveal", "folder", "Show in Finder") + (j.file ? b("open", "external", "Open file") : "")) + b("remove", "trash", "Remove from list");
      default: return b("retry", "refresh", "Try again") + b("remove", "trash", "Remove from list");
    }
  }

  const isIndeterminate = (j) => j.status === "running" && (!j.pct || j.pct >= 99.5 || (j.stage && !/^(Downloading|Starting)$/.test(j.stage)));

  function html(j) {
    const [main, side] = statLine(j);
    const meta = [j.label, j.site].filter(Boolean).join(" · ");
    const thumb = j.thumb ? `<img src="${CG.esc(j.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : I(KIND_ICON[j.kind] || "video", 22);
    return `<article class="job ${j.status}" data-id="${j.id}" data-status="${j.status}">
      <div class="thumb">${thumb}${j.duration ? `<span class="dur">${CG.fmtDur(j.duration)}</span>` : ""}</div>
      <div class="body" style="min-width:0">
        <div class="title" title="${CG.esc(j.title)}">${CG.esc(j.title)}</div>
        <div class="meta">${CG.esc(meta)}</div>
        <div class="bar${isIndeterminate(j) ? " ind" : ""}"><i style="width:${Math.min(j.pct || 0, 100)}%"></i></div>
        <div class="stat"><span class="st-main" title="${CG.esc(main)}">${CG.esc(main)}</span><span class="st-side num">${CG.esc(side)}</span></div>
      </div>
      <div class="acts">${actions(j)}</div>
    </article>`;
  }

  function build(j) {
    const t = document.createElement("template");
    t.innerHTML = html(j).trim();
    return t.content.firstElementChild;
  }

  function update(el, j) {
    const [main, side] = statLine(j);
    const bar = el.querySelector(".bar");
    bar.classList.toggle("ind", isIndeterminate(j));
    bar.firstElementChild.style.width = Math.min(j.pct || 0, 100) + "%";
    const m = el.querySelector(".st-main");
    if (m.textContent !== main) { m.textContent = main; m.title = main; }
    el.querySelector(".st-side").textContent = side;
  }

  /** Make `box` show exactly `list`, touching as little DOM as possible. */
  function sync(box, list) {
    box._jobs = Object.fromEntries(list.map((j) => [j.id, j]));
    const existing = new Map([...box.querySelectorAll(":scope > .job")].map((e) => [e.dataset.id, e]));
    list.forEach((j, i) => {
      let el = existing.get(j.id);
      existing.delete(j.id);
      if (!el || el.dataset.status !== j.status) {
        const fresh = build(j);
        if (el) el.replaceWith(fresh);
        el = fresh;
      } else update(el, j);
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    });
    existing.forEach((e) => e.remove());
  }

  function bind(box, toast) {
    box.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-op]");
      if (!btn) return;
      const id = btn.closest(".job").dataset.id;
      const j = box._jobs?.[id];
      const op = btn.dataset.op;
      if (op === "reveal" || op === "open") {
        try { await CG.nativeCall({ action: op, path: j.file, dir: j.dir }); }
        catch (err) { toast && toast(err.message); }
      } else chrome.runtime.sendMessage({ type: "job", op, id });
    });
  }

  return { sync, bind, html };
})();
