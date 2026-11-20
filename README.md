<div align="center">

# TurboFetch

### Your browser. Your media. One clean download workflow.

<p>
  <img src="TurboFetch%20Neon%20Video%20Downloader.png" alt="TurboFetch neon downloader artwork" width="760">
</p>

**A powerful Chromium extension with a native helper for video, audio, subtitles, and direct-file downloads.**

[Features](#-features) · [Installation](#-installation) · [Usage](#-how-to-use) · [Troubleshooting](#-troubleshooting)

</div>

---

## ✨ Features

- **Media inspection** — inspect available video, audio, and subtitle formats before downloading.
- **Quality choices** — select available resolutions, including 1080p and higher when the source provides them.
- **Audio extraction** — save MP3 or M4A audio, or keep the original stream.
- **Subtitles** — download subtitles separately or embed them in supported downloads.
- **Download queue** — pause, resume, cancel, retry, and clear completed jobs.
- **Two download modes** — save through the TurboFetch helper or send a ready-made file to Chrome's download manager.
- **Quick capture** — add links from the popup, manager, YouTube page button, or browser context menu.
- **Personal settings** — configure destination folder, quality, concurrency, cookies, filename template, notifications, and theme.
- **Tool updates** — check and update yt-dlp from Setup & updates.
- **Optional MEGA support** — use MEGAcmd for MEGA links.
- **Polished interface** — light, dark, and system themes with responsive popup and manager pages.

> TurboFetch is a browser extension plus a native-messaging helper. It is not a standalone macOS desktop app.

## 🧰 Requirements

- Chrome 110+ or a current Chromium-based browser (Brave, Edge, or Chromium).
- macOS for `install.sh`; Windows users should use `build_windows.ps1`.
- Python 3.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — media extraction and downloads.
- [FFmpeg](https://ffmpeg.org/) — merging separate audio/video streams and audio conversion.
- [Deno](https://deno.com/) — recommended JavaScript runtime for current YouTube extraction.
- [Node.js](https://nodejs.org/) — installed by `install.sh` to support the optional PhantomJS installer.
- [PhantomJS](https://phantomjs.org/) — legacy compatibility utility only; **TurboFetch does not currently use it**.
- [MEGAcmd](https://github.com/meganz/MEGAcmd) — optional, only for MEGA links.

Site support and available formats depend on yt-dlp, the source website, and installed helper tools.

## 🚀 Installation

### macOS — automated

1. Install [Homebrew](https://brew.sh/) if it is not already installed.
2. Download or clone this repository.
3. Open Terminal in the repository root and run:

   ```bash
   chmod +x install.sh
   ./install.sh
   ```

   The installer installs Python, yt-dlp, FFmpeg, Deno, and Node.js with Homebrew; attempts to install the legacy PhantomJS binary; installs and self-tests the native helper; and registers it with Chrome and any detected Chromium browsers.

4. Open `chrome://extensions`.
5. Enable **Developer mode** → **Load unpacked** → select the repository's `extension/` folder.
6. Fully quit and reopen the browser.
7. Open TurboFetch → **Setup & updates** → **Check again**.

To install optional MEGA support as well:

```bash
./install.sh --with-mega
```

To remove the native helper registration and installed helper files:

```bash
./install.sh --uninstall
```

Remove the unpacked browser extension separately from the browser's extensions page.

### Windows

1. Install Python 3 and ensure the `py` launcher is available.
2. Install the runtime tools from PowerShell:

   ```powershell
   winget install --id yt-dlp.yt-dlp --exact
   winget install --id Gyan.FFmpeg --exact
   winget install --id DenoLand.Deno --exact
   ```

3. In PowerShell, run from the repository root:

   ```powershell
   ./build_windows.ps1
   ```

4. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`), enable **Developer mode**, and choose **Load unpacked**.
5. Select the generated `dist\extension` directory, then fully restart the browser.

Uninstall the registered helper with:

```powershell
./build_windows.ps1 -Uninstall
```

The Windows build script builds the native host with PyInstaller. It does not install yt-dlp, FFmpeg, or Deno; install those separately as shown above. PhantomJS is not required by TurboFetch and is not installed by the Windows build script.

### Linux

Linux is not currently supported by the native helper's installation and path handling. The supplied `install.sh` intentionally stops on Linux rather than creating a broken native-messaging registration.

## 🎬 How to use

1. Visit a supported media page and click the TurboFetch toolbar icon.
2. Wait for formats to load.
3. Choose **Video**, **Audio**, or **Subtitles**, then select the format or quality.
4. Click **Download** to start now, or **Download later** to queue it paused.
5. Open the Download manager to control active and queued jobs.
6. To add a URL directly, paste it into the manager's quick-add field.

**Helper mode** saves files to the configured TurboFetch folder. **Send the link to Chrome** uses Chrome's own download manager and its configured download location; this mode is limited to ready-made files exposed by the source.

## 🗂️ Download location

The default helper-managed folder is:

```text
~/Downloads/TurboFetch
```

You can change it in **TurboFetch → Settings → Save folder**.

If you are changing the default in source code, update these three places so both download modes and the settings UI agree:

| File | Setting |
|---|---|
| `host/host.py` | `DEFAULT_DIR` — helper-managed default folder |
| `extension/background.js` | `filename: "TurboFetch/" + name` — Chrome-managed download subfolder |
| `extension/manager.html` | Save-folder input placeholder |

The native host identifier `com.bytebridge.host` is an internal protocol name shared by `extension/shared.js`, the platform installers, and the native-messaging manifest. It does not determine the visible app name or download folder; do not rename it unless you update every matching registration and reference together.

## 🧪 Development and checks

The project contains a Manifest V3 browser extension (`extension/`) and a Python native helper (`host/host.py`).

Run the native helper self-test:

```bash
python3 host/host.py --selftest
```

Check JavaScript syntax with Node.js:

```bash
for file in extension/*.js; do node --check "$file"; done
```

The Windows build creates `dist/` and `.build-venv/` as generated output.

## 🛠️ Troubleshooting

- **The extension cannot connect to the helper:** rerun the platform installer, fully quit the browser, and reopen it.
- **The browser says the helper is forbidden:** make sure the extension ID in `extension/manifest.json` matches the ID in the native host manifest.
- **YouTube requests sign-in or bot confirmation:** enable **Use cookies from a browser** in TurboFetch settings. The browser may ask permission to access stored cookies.
- **High-resolution downloads fail to merge:** install or update FFmpeg.
- **YouTube extraction is unreliable:** update yt-dlp and ensure Deno is installed; recent yt-dlp versions can also use Node.js as a fallback.
- **MEGA links do not work:** install MEGAcmd separately or rerun `./install.sh --with-mega`.

macOS helper log:

```text
~/Library/Logs/byteBridge.log
```

Windows helper log:

```text
%LOCALAPPDATA%\byteBridge\Logs\byteBridge.log
```

## 🤝 Contributing

Bug reports, focused fixes, and documentation improvements are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## ❤️ Support

If TurboFetch helps you, consider supporting its development. The donation wallet addresses are displayed in the app's Support panel.

### 💎 TON
**Network:** TON

`UQAXA1ITJ4Y-5sHeRCjs7KS9jKi-Y_bpcx0LEXnB3yRq-oSl`

### ⟠ Ethereum (ETH) And 💵 USDT
**Network:** Ethereum

`0xb381dc93fb3a40836d40cc438c3bb67f1b08b1a5`

### Thank you for supporting my projects! ❤️

## 📄 License

This project is released under the MIT License. See [LICENSE](LICENSE).
