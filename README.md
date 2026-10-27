# HLS Grabber

A Chrome extension (Manifest V3) that detects HLS (`.m3u8`) streams on a page, downloads the segments, and saves them as a single `.mp4` file. Conversion happens locally in your browser using [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).

## Features

- Detects `.m3u8` streams per tab, with a badge showing the count
- Picks the highest-bandwidth variant from master playlists
- Supports AES-128 encrypted streams and fMP4 (`EXT-X-MAP`) streams
- Download queue with up to **3 parallel downloads**
- **Cancel** button for queued and running jobs
- Per-tab queue view: downloads from other tabs keep running in the background
- Automatic file naming from the title of the item you last clicked on a page (class names such as `mt-liveClassName`), with a numbered fallback (`001.mp4`, `002.mp4`, ...)
- Sets `Referer`/`Origin` headers for stream requests so protected hosts work

## Install (developer mode)

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

## Usage

1. Open a page and play the video so the stream is detected.
2. Click the extension icon, then **+ Queue** on a stream (or **+ Queue all**).
3. The file is saved to your Chrome downloads folder when finished.

### File naming

`src/content.js` remembers the text of the last clicked element whose class contains `ClassName` / `class-name`. That title is kept per tab and passed to a video opened in a new tab, so it still applies when the video is on a different page from the list. To support other sites, edit `SELECTORS` in `src/content.js`.

### Settings in code

| Setting | File | Default |
| --- | --- | --- |
| `MAX_PARALLEL` | `src/background.js` | `3` |
| `CONCURRENCY` (segments fetched at once per job) | `src/offscreen/offscreen.js` | `8` |

## Project structure

```
manifest.json
src/
  background.js          Stream detection, job queue, header rules, downloads
  content.js             Captures the clicked item's title for file naming
  popup/                 Popup UI (popup.html, popup.js)
  offscreen/             Fetches segments, decrypts, remuxes with ffmpeg
lib/ffmpeg/              Bundled ffmpeg.wasm (ffmpeg.js, ffmpeg-core.js/.wasm, 814.ffmpeg.js)
icons/                   Extension icons (icon16/32/48/128.png) and source.png
```

## Limitations

- DRM / SAMPLE-AES streams are not supported.
- Videos are assembled in memory, so very large videos and many parallel jobs use a lot of RAM.
- Streams with separate audio and video playlists are not merged.

## Disclaimer

Use this tool only for content you have the right to download. You are responsible for complying with the terms of service and copyright laws that apply to you.

## License

[MIT](LICENSE). Made by [Pratham Kankheria](https://github.com/prathamkankheria). ffmpeg.wasm and FFmpeg are distributed under their own licenses (FFmpeg is LGPL/GPL depending on build).
