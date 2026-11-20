#!/usr/bin/env python3
"""byteBridge native host (v2).

One short-lived process per request. The extension talks to it with Chrome's
native-messaging protocol (4-byte length + JSON, both directions).

Requests (first message):
  probe     {url, compat, cookies}            -> {"type":"probe", ...}   formats + subtitles
  download  {job, settings}                   -> progress... then {"type":"done", status}
              (later messages "pause" / "cancel" stop it; stdin closing == pause)
  geturl    {url, fmt}                        -> {"type":"link", url, filename}
  check     {}                                -> {"type":"tools", ...}
  update    {}                                -> log lines, then {"type":"done"}
  install   {pkg}                             -> brew install of a whitelisted package
  reveal    {path, dir} / open {path}
  pickfolder{}                                -> {"type":"folder", path}
  cleanup   {id}                              -> removes temp files of a cancelled job
"""
import json, os, re, shutil, signal, struct, subprocess, sys, threading, time, traceback, tempfile, urllib.request, urllib.error
from urllib.parse import urlparse, parse_qs, unquote

VERSION = "2.1.0"
HOME = os.path.expanduser("~")
if sys.platform == "win32":
    LOG_DIR = os.path.join(os.environ.get("LOCALAPPDATA", HOME), "byteBridge", "Logs")
else:
    LOG_DIR = os.path.join(HOME, "Library", "Logs")
LOG = os.path.join(LOG_DIR, "byteBridge.log")
TMP_ROOT = os.path.join(os.environ.get("LOCALAPPDATA", HOME), "byteBridge", "tmp")
DEFAULT_DIR = os.path.join(os.path.expanduser("~"), "Downloads", "TurboFetch")
DEFAULT_TEMPLATE = "%(title).150B [%(id)s].%(ext)s"
PLAYLIST_TEMPLATE = "%(playlist_title).80B/%(playlist_index)03d - %(title).150B [%(id)s].%(ext)s"
DIRECT_EXT = r"\.(zip|rar|7z|tar|gz|tgz|bz2|xz|pdf|dmg|pkg|iso|epub|mp3|m4a|flac|wav|mp4|mkv|mov|avi|webm|jpg|jpeg|png|gif|exe|apk|msi|deb)$"
COOKIE_BROWSERS = {"chrome", "chromium", "brave", "edge", "firefox", "safari", "opera", "vivaldi"}
BREW_PACKAGES = {"yt-dlp": ["yt-dlp"], "ffmpeg": ["ffmpeg"], "deno": ["deno"], "megacmd": ["--cask", "megacmd"]}

try:
    os.makedirs(LOG_DIR, exist_ok=True)
    sys.stderr = open(LOG, "a", buffering=1)  # anything that goes wrong lands in the log
except Exception:
    pass

# Chrome starts us with a tiny PATH, so add the usual Homebrew / Deno / MEGAcmd locations.
_extra_path = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
    os.path.join(HOME, ".deno", "bin"), os.path.join(HOME, ".local", "bin"),
    os.path.join(os.environ.get("LOCALAPPDATA", HOME), "Programs", "Python", "Python312", "Scripts"),
    os.path.join(os.environ.get("LOCALAPPDATA", HOME), "Microsoft", "WinGet", "Links")]
if sys.platform != "win32": _extra_path.append("/Applications/MEGAcmd.app/Contents/MacOS")
os.environ["PATH"] = os.pathsep.join(_extra_path + [os.environ.get("PATH", "")])


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- native messaging
_send_lock = threading.Lock()


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    if len(data) > 900_000:  # Chrome rejects host messages > 1 MB
        obj = {"type": obj.get("type", "error"), "error": "Response too large"}
        data = json.dumps(obj).encode("utf-8")
    with _send_lock:
        try:
            sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
            sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError):
            pass


# --------------------------------------------------------------------------- small helpers
def need(tool, hint):
    exe = shutil.which(tool)
    if not exe:
        raise RuntimeError(f"{tool} not found. Install it: {hint}")
    return exe


def expand(p):
    return os.path.abspath(os.path.expandvars(os.path.expanduser(p or DEFAULT_DIR)))


def safe_name(n):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", n).strip(" .")[:150] or "download"


def num(x):
    try:
        v = float(x)
        return v if v == v else None  # NaN guard
    except (TypeError, ValueError):
        return None


def run_quiet(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or "").strip()
    except Exception:
        return ""


_ytdlp_ver = None


def ytdlp_version():
    global _ytdlp_ver
    if _ytdlp_ver is None:
        exe = shutil.which("yt-dlp")
        _ytdlp_ver = run_quiet([exe, "--version"]) if exe else ""
    return _ytdlp_ver


def ver_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:4])


def ytdlp_base(o):
    """Arguments shared by every yt-dlp call."""
    exe = need("yt-dlp", "brew install yt-dlp ffmpeg deno")
    cmd = [exe, "--ignore-config", "--no-colors"]
    # YouTube needs a JS runtime (yt-dlp >= 2025.11.12). Deno is picked up automatically;
    # fall back to Node if that is all the user has.
    if not shutil.which("deno") and shutil.which("node") and ver_tuple(ytdlp_version()) >= (2025, 11, 12):
        cmd += ["--js-runtimes", "node"]
    ck = (o or {}).get("cookies")
    if ck in COOKIE_BROWSERS:
        cmd += ["--cookies-from-browser", ck]
    return cmd


def route(url):
    p = urlparse(url)
    host = p.netloc.lower()
    if host.endswith("mega.nz") or host.endswith("mega.co.nz"):
        return "mega"
    if re.search(DIRECT_EXT, p.path, re.I):
        return "direct"
    return "yt-dlp"


def last_error(text, default="Download failed"):
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    errs = [l for l in lines if l.startswith("ERROR")]
    return (errs or lines or [default])[-1][:300]


# --------------------------------------------------------------------------- probing (what can I download?)
def has(c):
    return c not in (None, "", "none")


def codec_name(vc):
    vc = (vc or "").lower()
    if vc.startswith(("avc", "h264")):
        return "H.264"
    if vc.startswith(("vp9", "vp09")):
        return "VP9"
    if vc.startswith(("av01", "av1")):
        return "AV1"
    if vc.startswith(("hev", "hvc", "h265")):
        return "HEVC"
    return vc.split(".")[0].upper() if vc else ""


def fsize(f, dur):
    s = num(f.get("filesize")) or num(f.get("filesize_approx"))
    if not s and dur and num(f.get("tbr")):
        s = f["tbr"] * 1000 / 8 * dur
    return int(s) if s else None


def summarize(info, compat=True):
    """Boil yt-dlp's huge JSON down to what the UI needs (must stay well under 1 MB)."""
    dur = num(info.get("duration"))
    video_only, audio_only, combined = [], [], []
    for f in info.get("formats") or []:
        fid = str(f.get("format_id") or "")
        if not fid or f.get("ext") == "mhtml" or "-drc" in fid or "storyboard" in (f.get("format_note") or ""):
            continue
        v, a = f.get("vcodec"), f.get("acodec")
        if v == "none" and a == "none":
            continue
        if v == "none":
            audio_only.append(f)
        elif a == "none":
            video_only.append(f)
        else:
            combined.append(f)

    # audio: keep the original-language track; prefer M4A when asked for compatibility
    if audio_only:
        best_lang = max((num(f.get("language_preference")) or 0) for f in audio_only)
        audio_only = [f for f in audio_only if (num(f.get("language_preference")) or 0) == best_lang]

    def abr_of(f):
        return num(f.get("abr")) or num(f.get("tbr")) or 0

    def a_key(f):
        m4a = 1 if (f.get("ext") == "m4a" or str(f.get("acodec", "")).startswith("mp4a")) else 0
        return ((m4a if compat else 0), abr_of(f))

    best_a = max(audio_only, key=a_key) if audio_only else None
    audio_pick = str(best_a["format_id"]) if best_a else None
    audio_pick_size = (fsize(best_a, dur) or 0) if best_a else 0

    seen, audio = set(), []
    for f in sorted(audio_only, key=lambda f: -abr_of(f)):
        abr = int(round(abr_of(f)))
        k = (f.get("ext"), abr)
        if k in seen:
            continue
        seen.add(k)
        label = {"m4a": "M4A (AAC)", "mp4": "M4A (AAC)", "webm": "Opus", "opus": "Opus", "mp3": "MP3"}.get(
            f.get("ext"), (f.get("ext") or "audio").upper())
        audio.append({"id": str(f["format_id"]), "label": label, "ext": f.get("ext"), "abr": abr or None, "size": fsize(f, dur)})
        if len(audio) >= 6:
            break

    # video rows: one per (height, 30/60 fps) bucket
    def v_key(f):
        c = codec_name(f.get("vcodec"))
        pref = {"H.264": 3, "VP9": 2, "AV1": 1}.get(c, 0) if compat else 0
        return (pref, num(f.get("tbr")) or 0)

    buckets = {}
    for merge, group in ((True, video_only), (False, combined)):
        for f in group:
            h = f.get("height")
            if not h:
                continue
            fps = num(f.get("fps")) or 30
            k = (h, 60 if fps >= 50 else 30)
            cur = buckets.get(k)
            # video-only streams (merged with the audio pick) beat ready-made combined ones
            if cur is None or (merge, v_key(f)) > (cur[1], v_key(cur[0])):
                buckets[k] = (f, merge)

    video = []
    for (h, fb), (f, merge) in sorted(buckets.items(), key=lambda kv: (-kv[0][0], -kv[0][1])):
        size = fsize(f, dur)
        do_merge = bool(merge and audio_pick)
        if do_merge and size is not None:
            size += audio_pick_size
        hdr = f.get("dynamic_range") or ""
        video.append({
            "key": f"{h}p{60 if fb == 60 else ''}", "id": str(f["format_id"]), "merge": do_merge,
            "height": h, "fps": int(num(f.get("fps")) or 0) or None,
            "label": f"{h}p" + ("60" if fb == 60 else ""),
            "codec": codec_name(f.get("vcodec")), "ext": "mp4" if do_merge else f.get("ext"),
            "hdr": hdr if hdr and hdr.upper() != "SDR" else "", "size": size,
            "res": f"{f.get('width')}×{h}" if f.get("width") else f"{h}p",
        })

    # single-file formats (used by "send link to Chrome": no merging needed)
    single = []
    for f in sorted(combined, key=lambda f: -(f.get("height") or 0)):
        if str(f.get("protocol", "")).startswith(("m3u8", "http_dash", "dash")) or not f.get("height"):
            continue
        single.append({"id": str(f["format_id"]), "height": f["height"], "label": f"{f['height']}p",
                       "ext": f.get("ext"), "size": fsize(f, dur), "codec": codec_name(f.get("vcodec"))})

    subs = [{"code": c, "name": (v[0].get("name") if v else None) or c}
            for c, v in (info.get("subtitles") or {}).items() if c != "live_chat"]
    auto = [{"code": c, "name": (v[0].get("name") if v else None) or c}
            for c, v in (info.get("automatic_captions") or {}).items()]
    auto.sort(key=lambda s: (not s["code"].endswith("-orig"), s["name"]))
    subs.sort(key=lambda s: s["name"])

    return {
        "type": "probe", "kind": "video", "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": dur, "thumbnail": info.get("thumbnail"), "site": info.get("extractor_key") or info.get("extractor"),
        "is_live": bool(info.get("is_live")), "video": video, "single": single, "audio": audio,
        "audio_pick": audio_pick, "subs": subs, "auto": auto,
    }


def summarize_playlist(info):
    entries = [e for e in (info.get("entries") or []) if e]
    thumb = info.get("thumbnail")
    if not thumb:
        for e in entries:
            ts = e.get("thumbnails") or []
            if e.get("thumbnail") or ts:
                thumb = e.get("thumbnail") or ts[-1].get("url")
                break
    return {"type": "probe", "kind": "playlist", "title": info.get("title"),
            "uploader": info.get("uploader") or info.get("channel"),
            "count": info.get("playlist_count") or len(entries), "thumbnail": thumb,
            "site": info.get("extractor_key"), "entries": [{"title": e.get("title"), "id": e.get("id")} for e in entries[:30]]}


def head_info(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 byteBridge/2.1"}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            hdr = response.headers
            final_url = response.geturl()
    except urllib.error.HTTPError as e:
        if e.code in (400, 403, 405, 501):
            try:
                retry_url = e.geturl() or url
                req = urllib.request.Request(retry_url, headers={"User-Agent": "Mozilla/5.0 byteBridge/2.1", "Range": "bytes=0-0"})
                with urllib.request.urlopen(req, timeout=20) as response:
                    hdr, final_url = response.headers, response.geturl()
            except urllib.error.HTTPError as get_error:
                raise RuntimeError(f"The server returned HTTP {get_error.code} ({get_error.reason}).")
            except urllib.error.URLError as get_error:
                raise RuntimeError(f"Could not reach the server: {get_error.reason}")
        else:
            raise RuntimeError(f"The server returned HTTP {e.code} ({e.reason}).")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach the server: {e.reason}")
    except Exception as e:
        raise RuntimeError(f"Could not inspect this link: {e}")
    name = None
    cd = hdr.get("Content-Disposition", "")
    m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", cd, re.I) or re.search(r'filename="?([^";]+)"?', cd, re.I)
    if m: name = unquote(m.group(1).strip())
    if not name: name = unquote(os.path.basename(urlparse(final_url).path)) or "download"
    content_range = hdr.get("Content-Range", "")
    range_match = re.search(r"/([0-9]+)$", content_range)
    size = int(range_match.group(1)) if range_match else (int(hdr.get("Content-Length")) if (hdr.get("Content-Length") or "").isdigit() else None)
    return safe_name(name), size


def playlist_only(url):
    p = urlparse(url)
    h = p.netloc.lower()
    return ("youtube.com" in h or "youtu.be" in h) and p.path.startswith("/playlist")


def probe(msg):
    url = msg["url"]
    kind = route(url)
    if kind == "mega":
        return send({"type": "probe", "kind": "mega", "title": "MEGA file", "site": "MEGA"})
    if kind == "direct":
        try:
            name, size = head_info(url)
            return send({"type": "probe", "kind": "direct", "title": name, "filename": name, "size": size,
                         "site": urlparse(url).netloc.replace("www.", "")})
        except RuntimeError as e:
            return send({"type": "probe", "error": str(e), "code": "unreachable"})
    try:
        cmd = ytdlp_base(msg)
    except RuntimeError as e:
        return send({"type": "probe", "error": str(e), "code": "missing-ytdlp"})
    cmd += ["-J", "--skip-download", "--flat-playlist" if playlist_only(url) else "--no-playlist", "--no-warnings", url]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return send({"type": "probe", "error": "Reading this link took too long. Try again."})
    if r.returncode != 0 or not r.stdout.strip():
        err = last_error(r.stderr, "Could not read this link")
        log("probe failed:", err)
        return send({"type": "probe", "error": err, "code": "unsupported" if "Unsupported URL" in err else "failed"})
    try:
        info = json.loads(r.stdout)
    except ValueError:
        return send({"type": "probe", "error": "yt-dlp returned unreadable data"})
    out = summarize_playlist(info) if info.get("_type") == "playlist" else summarize(info, msg.get("compat", True))
    out["in_playlist"] = bool(parse_qs(urlparse(url).query).get("list")) and out["kind"] == "video"
    out["has_js_runtime"] = bool(shutil.which("deno") or shutil.which("node"))
    send(out)


# --------------------------------------------------------------------------- running a download
class Ctl:
    """Lets the reader thread stop whatever the main thread is running."""

    def __init__(self):
        self.proc = None
        self.stop = None
        self.lock = threading.Lock()

    def attach(self, proc):
        with self.lock:
            self.proc = proc
            if self.stop:
                self._kill()

    def request_stop(self, reason):
        with self.lock:
            self.stop = self.stop or reason
            self._kill()

    def _kill(self):
        p = self.proc
        if p and p.poll() is None:
            try:
                if sys.platform == "win32": subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
                else: os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                return
            t = threading.Timer(4, lambda: p.poll() is None and _hard_kill(p))
            t.daemon = True
            t.start()


def _hard_kill(p):
    try:
        if sys.platform == "win32": subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
        else: os.killpg(p.pid, signal.SIGKILL)
    except Exception:
        pass


def listen_for_stop(ctl):
    def loop():
        while True:
            try:
                m = read_msg()
            except Exception:
                m = None
            if m is None:  # Chrome closed the port: keep partial files so it can resume later
                ctl.request_stop("pause")
                return
            if m.get("action") in ("pause", "cancel"):
                ctl.request_stop(m["action"])
    threading.Thread(target=loop, daemon=True).start()


def iter_lines(proc):
    """Yield output lines, treating both \\n and \\r as line ends (curl / MEGAcmd use \\r)."""
    fd = proc.stdout.fileno()
    buf = b""
    while True:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()
        for p in parts:
            if p.strip():
                yield p.decode("utf-8", "replace").strip()
    if buf.strip():
        yield buf.decode("utf-8", "replace").strip()


def build_ytdlp(job, o, tmp, out_dir):
    s = job["spec"]
    kind = job.get("kind")
    sb = s.get("subs") or {}
    cmd = ytdlp_base(o)
    cmd += ["--newline", "--progress",
            "--progress-template", "download:CGP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
            "--progress-template", "postprocess:CGPP|%(progress.status)s|%(progress.postprocessor)s",
            "-P", "home:" + out_dir, "-P", "temp:" + tmp,
            "-N", "4", "--retries", "10", "--fragment-retries", "10"]
    playlist = bool(s.get("playlist"))
    tpl = (o.get("template") or "").strip() or DEFAULT_TEMPLATE
    cmd += ["-o", PLAYLIST_TEMPLATE if playlist else tpl]
    cmd.append("--yes-playlist" if playlist else "--no-playlist")
    os.makedirs(tmp, exist_ok=True)
    cmd += ["--print-to-file", "after_move:%(filepath)s", os.path.join(tmp, "files.txt")]

    if kind == "subs":
        cmd += ["--skip-download"]
    else:
        cmd += ["-f", s.get("fmt") or "bv*+ba/b", "--embed-metadata"]
        if kind == "audio":
            conv = s.get("convert") or "original"
            if conv in ("mp3", "m4a"):
                cmd += ["-x", "--audio-format", conv, "--audio-quality", "0"]
            elif s.get("fmt") in (None, "ba/b", "bestaudio/best"):
                cmd += ["-x", "--audio-format", "best"]
        else:
            cmd += ["--merge-output-format", "mp4"]

    if sb.get("langs"):
        cmd += ["--write-subs", "--sub-langs", ",".join(sb["langs"])]
        if sb.get("auto"):
            cmd.append("--write-auto-subs")
        cmd += ["--sub-format", "vtt/best", "--convert-subs", "vtt" if sb.get("format") == "vtt" else "srt"]
        if sb.get("embed") and kind == "video":
            cmd.append("--embed-subs")
    return cmd + [job["url"]]


def unique_path(path):
    base, ext = os.path.splitext(path)
    n, cand = 1, path
    while os.path.exists(cand):
        cand = f"{base} ({n}){ext}"
        n += 1
    return cand


def newest_since(root, t0):
    best, best_t = None, t0 - 2
    for dp, dn, fn in os.walk(root):
        if dp[len(root):].count(os.sep) >= 2:
            dn[:] = []
        dn[:] = [d for d in dn if not d.startswith(".")]
        for f in fn:
            if f.startswith(".") or f.endswith((".part", ".ytdl")):
                continue
            p = os.path.join(dp, f)
            try:
                t = os.path.getmtime(p)
            except OSError:
                continue
            if t >= best_t:
                best, best_t = p, t
    return best


STAGES = {"FFmpegMerger": "Merging video + audio", "FFmpegExtractAudio": "Converting audio",
          "FFmpegEmbedSubtitle": "Embedding subtitles", "FFmpegSubtitlesConvertor": "Converting subtitles",
          "MoveFiles": "Saving", "FFmpegMetadata": "Writing tags"}


def run_download(msg, ctl):
    job, o = msg["job"], msg.get("settings") or {}
    out_dir = expand(o.get("dir"))
    tmp = os.path.join(TMP_ROOT, safe_name(job["id"]))
    os.makedirs(out_dir, exist_ok=True)
    tool = job.get("tool") or route(job["url"])
    send({"type": "start", "tool": tool})
    t0 = time.time()
    try:
        if tool == "direct":
            return run_direct(job, ctl, out_dir, tmp)
        cmd = ([need("mega-get", "brew install --cask megacmd"), job["url"], out_dir]
               if tool == "mega" else build_ytdlp(job, o, tmp, out_dir))
    except RuntimeError as e:
        return send({"type": "done", "status": "error", "error": str(e)})
    log("run:", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}))
    ctl.attach(proc)

    expected = num(job["spec"].get("expected")) or 0
    done_bytes, last_sent, err_text, dest = 0.0, 0.0, [], None
    for line in iter_lines(proc):
        if line.startswith("CGP|"):
            f = line.split("|")
            if len(f) < 7:
                continue
            status, cur = f[1], num(f[2]) or 0
            total = num(f[3]) or num(f[4]) or 0
            speed, eta = num(f[5]), num(f[6])
            if expected:
                pct = (done_bytes + cur) / max(expected, done_bytes + total) * 100
            elif total:
                pct = cur / total * 100
            else:
                pct = None
            if status == "finished":
                done_bytes += cur
            now = time.time()
            if status != "downloading" or now - last_sent > 0.3:
                last_sent = now
                send({"type": "progress", "pct": None if pct is None else min(pct, 99.5),
                      "speed": speed, "eta": eta, "stage": "Downloading"})
        elif line.startswith("CGPP|"):
            f = line.split("|")
            if len(f) >= 3 and f[1] == "started":
                send({"type": "progress", "stage": STAGES.get(f[2], "Processing"), "pct": 99.5, "speed": None, "eta": None})
        else:
            log(line)
            if line.startswith("ERROR"):
                err_text.append(line)
            m = re.search(r'(?:Destination:|Merging formats into|Writing video subtitles to:)\s*"?(.+?)"?$', line)
            if m:
                dest = m.group(1)
            if tool == "mega":
                m = re.search(r"(\d+(?:\.\d+)?)\s*%", line)
                if m and time.time() - last_sent > 0.3:
                    last_sent = time.time()
                    send({"type": "progress", "pct": min(float(m.group(1)), 99.5), "stage": "Downloading"})
    code = proc.wait()

    if ctl.stop == "cancel":
        if tool == "mega":
            run_quiet(["mega-transfers", "-c", "-a", "--only-downloads"])
        shutil.rmtree(tmp, ignore_errors=True)
        send({"type": "done", "status": "canceled"})
    elif ctl.stop:  # pause / Chrome closed
        send({"type": "done", "status": "paused"})
    elif code == 0:
        final = None
        try:
            with open(os.path.join(tmp, "files.txt")) as fh:
                paths = [l.strip() for l in fh if l.strip()]
            final = paths[-1] if paths else None
        except OSError:
            pass
        if not (final and os.path.exists(final)):
            final = newest_since(out_dir, t0)
        shutil.rmtree(tmp, ignore_errors=True)
        playlist = job["spec"].get("playlist")
        send({"type": "done", "status": "done", "dir": out_dir,
              "file": final if (final and os.path.exists(final) and not playlist) else None})
    else:
        send({"type": "done", "status": "error",
              "error": last_error("\n".join(err_text)) if err_text else f"{os.path.basename(cmd[0])} stopped with code {code}"})


def run_direct(job, ctl, out_dir, tmp):
    url, s = job["url"], job["spec"]
    name = safe_name(s.get("filename") or os.path.basename(urlparse(url).path))
    os.makedirs(tmp, exist_ok=True)
    part = os.path.join(tmp, name + ".part")
    total = num(s.get("expected")) or 0
    resume = True
    while True:
        cmd = [need("curl", "(ships with macOS)"), "-L", "-f", "--retry", "5", "--no-progress-meter", "-o", part, url]
        if resume:
            cmd[1:1] = ["-C", "-"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}))
        ctl.attach(proc)
        last_size, last_t, speed = (os.path.getsize(part) if os.path.exists(part) else 0), time.time(), 0.0
        while proc.poll() is None:
            time.sleep(0.4)
            size = os.path.getsize(part) if os.path.exists(part) else 0
            now = time.time()
            inst = (size - last_size) / max(now - last_t, 0.01)
            speed = inst if not speed else speed * 0.6 + inst * 0.4
            last_size, last_t = size, now
            eta = (total - size) / speed if total and speed > 1 else None
            send({"type": "progress", "pct": min(size / total * 100, 99.5) if total else None, "speed": speed,
                  "eta": eta, "stage": "Downloading", "downloaded": size})
        err = proc.stdout.read().decode("utf-8", "replace")
        code = proc.returncode
        if ctl.stop == "cancel":
            shutil.rmtree(tmp, ignore_errors=True)
            return send({"type": "done", "status": "canceled"})
        if ctl.stop:
            return send({"type": "done", "status": "paused"})
        if code == 33 and resume:  # server can't resume: start over without -C
            resume = False
            try:
                os.remove(part)
            except OSError:
                pass
            continue
        break
    if code != 0:
        return send({"type": "done", "status": "error", "error": last_error(err, f"curl failed (code {code})")})
    final = unique_path(os.path.join(out_dir, name))
    shutil.move(part, final)
    shutil.rmtree(tmp, ignore_errors=True)
    send({"type": "done", "status": "done", "dir": out_dir, "file": final})


# --------------------------------------------------------------------------- other actions
def get_link(msg):
    """Chrome-downloads mode: resolve a direct file link for the extension to hand to Chrome."""
    url = msg["url"]
    if route(url) == "direct":
        name, size = head_info(url)
        return send({"type": "link", "url": url, "filename": name, "size": size})
    try:
        cmd = ytdlp_base(msg)
    except RuntimeError as e:
        return send({"type": "link", "error": str(e)})
    cmd += ["-j", "--no-playlist", "--no-warnings", "-f", msg.get("fmt") or "b", url]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    for line in r.stdout.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if j.get("url") and not str(j.get("protocol", "")).startswith(("m3u8", "http_dash")):
            return send({"type": "link", "url": j["url"],
                         "filename": safe_name(f"{j.get('title', 'video')}.{j.get('ext', 'mp4')}"),
                         "size": j.get("filesize") or j.get("filesize_approx")})
    send({"type": "link", "error": last_error(r.stderr, "This format is not a single file. Pick a lower quality or use the helper.")})


def ytdlp_method():
    exe = shutil.which("yt-dlp")
    if not exe:
        return None, None
    real = os.path.realpath(exe)
    if "/Cellar/" in real or "/homebrew/" in real.lower():
        return "brew", None
    if sys.platform == "win32" and shutil.which("winget"):
        return "winget", None
    try:
        with open(real, "rb") as fh:
            first = fh.readline(200)
        if first.startswith(b"#!") and b"python" in first:
            return "pip", first[2:].decode().split()[0]
    except OSError:
        pass
    return "binary", None


def check():
    def ver(cmd, rx=r"(\d[\w.\-+]*)"):
        out = run_quiet(cmd)
        m = re.search(rx, out.splitlines()[0]) if out else None
        return m.group(1) if m else None

    yt, ff, dn, nd = (shutil.which(x) for x in ("yt-dlp", "ffmpeg", "deno", "node"))
    send({"type": "tools", "host": VERSION, "python": sys.version.split()[0], "brew": bool(shutil.which("brew")),
          "method": ytdlp_method()[0], "log": LOG, "tools": {
              "yt-dlp": {"ok": bool(yt), "version": ytdlp_version() if yt else None},
              "ffmpeg": {"ok": bool(ff), "version": ver([ff, "-version"], r"version\s+(\S+)") if ff else None},
              "deno": {"ok": bool(dn), "version": ver([dn, "--version"]) if dn else None},
              "node": {"ok": bool(nd), "version": ver([nd, "--version"]) if nd else None},
              "megacmd": {"ok": bool(shutil.which("mega-get")), "version": None},
          }})


def stream_cmd(cmd):
    log("run:", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}))
    tail = []
    for line in iter_lines(proc):
        tail.append(line)
        send({"type": "log", "line": line[:300]})
    return proc.wait(), "\n".join(tail[-8:])


def do_update():
    method, py = ytdlp_method()
    before = ytdlp_version()
    if method is None:
        return send({"type": "done", "status": "error", "error": "yt-dlp is not installed"})
    try:
        if method == "brew":
            cmd = [need("brew", "https://brew.sh"), "upgrade", "yt-dlp"]
        elif method == "winget":
            cmd = [need("winget", "Install App Installer from Microsoft Store"), "upgrade", "--id", "yt-dlp.yt-dlp", "--exact", "--silent"]
        elif method == "pip":
            cmd = [py, "-m", "pip", "install", "-U", "yt-dlp[default]"]
        else:
            cmd = [shutil.which("yt-dlp"), "-U"]
    except RuntimeError as e:
        return send({"type": "done", "status": "error", "error": str(e)})
    code, tail = stream_cmd(cmd)
    after = run_quiet([shutil.which("yt-dlp"), "--version"])
    send({"type": "done", "status": "done" if code == 0 else "error", "method": method,
          "before": before, "after": after, "error": None if code == 0 else last_error(tail, "Update failed")})


def do_install(msg):
    pkg = msg.get("pkg")
    if pkg not in BREW_PACKAGES:
        return send({"type": "done", "status": "error", "error": "Unknown package"})
    brew = shutil.which("brew")
    if sys.platform == "win32":
        packages = {"yt-dlp": "yt-dlp.yt-dlp", "ffmpeg": "Gyan.FFmpeg", "deno": "DenoLand.Deno"}
        package = packages.get(pkg)
        winget = shutil.which("winget")
        if not package or not winget:
            return send({"type": "done", "status": "error", "error": "Install yt-dlp, FFmpeg and Deno with winget or their official Windows installers."})
        code, tail = stream_cmd([winget, "install", "--id", package, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements"])
    else:
        if not brew:
            return send({"type": "done", "status": "error", "error": "Homebrew is not installed. Get it from https://brew.sh"})
        code, tail = stream_cmd([brew, "install"] + BREW_PACKAGES[pkg])
    send({"type": "done", "status": "done" if code == 0 else "error", "error": None if code == 0 else last_error(tail)})


def reveal(msg):
    path, d = msg.get("path"), msg.get("dir")
    target = path if path and os.path.exists(path) else (expand(d) if d and os.path.isdir(expand(d)) else expand(None))
    if sys.platform == "win32":
        if path and os.path.exists(path): os.startfile(os.path.dirname(path))
        else: os.startfile(target)
    elif sys.platform == "darwin":
        subprocess.run(["open", "-R", path] if path and os.path.exists(path) else ["open", target])
    else:
        subprocess.run(["xdg-open", os.path.dirname(path) if path and os.path.exists(path) else target])
    send({"type": "done", "status": "done"})


def open_file(msg):
    path = msg.get("path")
    if path and os.path.exists(path):
        if sys.platform == "win32": os.startfile(path)
        elif sys.platform == "darwin": subprocess.run(["open", path])
        else: subprocess.run(["xdg-open", path])
    send({"type": "done", "status": "done"})


def pick_folder():
    try:
        if sys.platform == "win32":
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
            out = filedialog.askdirectory(title="Choose where byteBridge saves files")
            root.destroy()
        elif sys.platform == "darwin":
            out = run_quiet(["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose where byteBridge saves files")'], 300).rstrip("/")
        else:
            out = ""
        send({"type": "folder", "path": out or None})
    except Exception as e:
        send({"type": "folder", "path": None, "error": str(e)})


def main():
    if "--selftest" in sys.argv:
        print("host ok, python", sys.version.split()[0])
        return
    log("host", VERSION, "started, python", sys.version.split()[0])
    try:
        msg = read_msg() or {}
        act = msg.get("action")
        log("action:", act)
        if act == "probe":
            probe(msg)
        elif act == "download":
            ctl = Ctl()
            listen_for_stop(ctl)
            run_download(msg, ctl)
        elif act == "geturl":
            get_link(msg)
        elif act == "check":
            check()
        elif act == "update":
            do_update()
        elif act == "install":
            do_install(msg)
        elif act == "reveal":
            reveal(msg)
        elif act == "open":
            open_file(msg)
        elif act == "pickfolder":
            pick_folder()
        elif act == "cleanup":
            shutil.rmtree(os.path.join(TMP_ROOT, safe_name(msg.get("id", "x"))), ignore_errors=True)
            send({"type": "done", "status": "done"})
        else:
            send({"type": "done", "status": "error", "error": "Unknown action"})
    except Exception as e:
        log(traceback.format_exc())
        send({"type": "done", "status": "error",
              "error": "Helper crashed: " + str(e)[:150] + " (see " + LOG + ")"})
    sys.stdout.flush()
    os._exit(0)  # don't wait on the reader thread blocked on stdin


if __name__ == "__main__":
    main()
