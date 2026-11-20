#!/usr/bin/env bash
# TurboFetch macOS installer — installs helper tools and registers native messaging.
# Usage: ./install.sh [--uninstall] [--with-mega]
set -Eeuo pipefail

APP_NAME="TurboFetch"
HOST_NAME="com.bytebridge.host" # Keep in sync with extension/shared.js and manifest registrations.
EXT_ID="cfjmpidkokhhloiognboaiembblpjaid"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOME_HOST="$HOME/.bytebridge/host"
BASE="$HOME/Library/Application Support"
BROWSERS=("Google/Chrome" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge")

log() { printf '\n[%s] %s\n' "$APP_NAME" "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  for browser in "${BROWSERS[@]}"; do
    rm -f "$BASE/$browser/NativeMessagingHosts/$HOST_NAME.json"
  done
  rm -rf "$HOME/.bytebridge"
  log "Native helper registration removed. Remove the unpacked extension from your browser separately."
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] || die "This install.sh supports macOS only. Use build_windows.ps1 on Windows. Linux is not currently supported by host.py."
[[ -d "$ROOT/host" && -f "$ROOT/host/host.py" && -d "$ROOT/extension" ]] || die "Run this script from the extracted TurboFetch repository root."

if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew is required. Install it from https://brew.sh/ and run this script again."
fi

log "Installing runtime dependencies with Homebrew..."
brew update
brew install python yt-dlp ffmpeg deno

PYTHON="$(command -v python3 || true)"
[[ -n "$PYTHON" ]] || die "python3 was not found after Homebrew installation."

# PhantomJS is legacy and TurboFetch does not call it. Install it as an optional
# compatibility utility because the user requested it; failure is non-fatal.
  

if [[ "${2:-}" == "--with-mega" || "${1:-}" == "--with-mega" ]]; then
  brew install --cask megacmd
fi

mkdir -p "$HOME_HOST"
install -m 755 "$ROOT/host/host.py" "$HOME_HOST/host.py"

cat > "$HOME_HOST/run_host.sh" <<LAUNCH
#!/usr/bin/env bash
exec "$PYTHON" "$HOME_HOST/host.py" "\$@"
LAUNCH
chmod 755 "$HOME_HOST/run_host.sh"

log "Running native helper self-test..."
"$HOME_HOST/run_host.sh" --selftest

export TURBOFETCH_HOST_NAME="$HOST_NAME"
export TURBOFETCH_HOST_PATH="$HOME_HOST/run_host.sh"
export TURBOFETCH_EXTENSION_ID="$EXT_ID"
export TURBOFETCH_BASE="$BASE"
python3 - <<'PY'
import json, os
host_name = os.environ["TURBOFETCH_HOST_NAME"]
host_path = os.environ["TURBOFETCH_HOST_PATH"]
extension_id = os.environ["TURBOFETCH_EXTENSION_ID"]
base = os.environ["TURBOFETCH_BASE"]
manifest = {
    "name": host_name,
    "description": "TurboFetch native messaging helper",
    "path": host_path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
for browser in ("Google/Chrome", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge"):
    folder = os.path.join(base, browser, "NativeMessagingHosts")
    # Register Chrome by default; register other Chromium browsers only if present.
    if browser == "Google/Chrome" or os.path.isdir(os.path.dirname(folder)):
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, host_name + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        print(f"Registered: {browser}")
PY

log "Checking installed tools..."
for tool in yt-dlp ffmpeg deno phantomjs; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '  ✓ %s: %s\n' "$tool" "$(command -v "$tool")"
  else
    printf '  ! %s not found\n' "$tool"
  fi
done

log "Installation complete."
cat <<'NEXT'

Next:
  1. Open chrome://extensions (or edge://extensions / brave://extensions).
  2. Enable Developer mode → Load unpacked → select this repository's extension/ folder.
  3. Fully quit and reopen the browser.
  4. Open TurboFetch → Setup & updates → Check again.

Uninstall helper registration:
  ./install.sh --uninstall

Optional MEGA support:
  ./install.sh --with-mega

Note: PhantomJS is an archived legacy runtime and is not used by TurboFetch.
NEXT
