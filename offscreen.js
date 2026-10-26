const CONCURRENCY = 8;
const worker = new Worker("mux-worker.js");
let current = null; // {tabId, title}

const send = m => chrome.runtime.sendMessage(m).catch(() => {});
const abs = (u, base) => new URL(u, base).href;

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== "process") return;
  current = { tabId: msg.tabId, title: msg.title };
  run(msg.url).catch(e => send({ type: "error", tabId: msg.tabId, error: String(e.message || e) }));
});

async function getText(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`Playlist HTTP ${r.status}`);
  return r.text();
}

async function fetchRetry(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(-60)}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function pool(n, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < n) await fn(next++);
  }));
}

async function resolveMedia(url) {
  const text = await getText(url);
  if (!text.includes("#EXT-X-STREAM-INF")) return { url, text };
  const lines = text.split("\n").map(l => l.trim());
  let best = { bw: -1, uri: null };
  lines.forEach((l, i) => {
    const m = l.match(/BANDWIDTH=(\d+)/);
    if (l.startsWith("#EXT-X-STREAM-INF") && m && +m[1] > best.bw) best = { bw: +m[1], uri: lines[i + 1] };
  });
  return resolveMedia(abs(best.uri, url));
}

function parseMedia({ url, text }) {
  const segs = []; let key = null, seq = 0, map = null;
  const lines = text.split("\n").map(l => l.trim());
  const ms = lines.find(l => l.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  if (ms) seq = +ms.split(":")[1];
  for (const l of lines) {
    if (l.startsWith("#EXT-X-KEY")) {
      const method = /METHOD=([^,]+)/.exec(l)[1];
      if (method === "SAMPLE-AES") throw new Error("SAMPLE-AES/DRM streams are not supported");
      key = method === "NONE" ? null : {
        uri: abs(/URI="([^"]+)"/.exec(l)[1], url),
        iv: (/IV=0x([0-9a-f]+)/i.exec(l) || [])[1]
      };
    } else if (l.startsWith("#EXT-X-MAP")) {
      map = abs(/URI="([^"]+)"/.exec(l)[1], url);
    } else if (l && !l.startsWith("#")) {
      segs.push({ url: abs(l, url), key, seq: seq++ });
    }
  }
  return { segs, map, ended: text.includes("#EXT-X-ENDLIST") };
}

const hexToBytes = h => Uint8Array.from(h.padStart(32, "0").match(/../g), b => parseInt(b, 16));

// strips fake image headers etc. so data starts at real MPEG-TS
function stripToTS(u8) {
  for (let i = 0; i < Math.min(u8.length, 4096); i++)
    if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) return i ? u8.subarray(i) : u8;
  return u8;
}

const safeName = t => (t || "video").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "video";

async function run(m3u8Url) {
  const { tabId, title } = current;
  const report = (done, total, status) => send({ type: "progress", tabId, done, total, status });

  report(0, 0, "Reading playlist…");
  const { segs, map, ended } = parseMedia(await resolveMedia(m3u8Url));
  if (!segs.length) throw new Error("No segments found in playlist");

  const results = new Array(segs.length);
  const keyCache = new Map();
  let done = 0;
  report(0, segs.length, ended ? "Downloading…" : "Downloading (live/incomplete stream)…");

  const initData = map ? await fetchRetry(map) : null;

  await pool(segs.length, CONCURRENCY, async i => {
    const s = segs[i];
    let data = await fetchRetry(s.url);
    if (s.key) {
      if (!keyCache.has(s.key.uri)) {
        keyCache.set(s.key.uri, fetchRetry(s.key.uri).then(raw =>
          crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"])));
      }
      const ck = await keyCache.get(s.key.uri);
      let iv;
      if (s.key.iv) iv = hexToBytes(s.key.iv);
      else { iv = new Uint8Array(16); new DataView(iv.buffer).setUint32(12, s.seq); }
      data = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, data));
    }
    results[i] = initData ? data : stripToTS(data);
    report(++done, segs.length, "Downloading…");
  });

  const filename = "video.mp4"; // real numbered name is assigned in background.js

  if (initData) { // fMP4: already MP4, just concatenate
    report(done, segs.length, "Saving…");
    finish(new Blob([initData, ...results], { type: "video/mp4" }), filename, tabId);
    return;
  }

  report(done, segs.length, "Converting to MP4…");
  worker.onmessage = e => finish(e.data, filename, tabId);
  worker.onerror = e => send({ type: "error", tabId, error: "Remux failed: " + e.message });
  worker.postMessage(results, results.map(r => r.buffer));
}

function finish(blob, filename, tabId) {
  if (!blob.size) return send({ type: "error", tabId, error: "Output is empty (unsupported codec/format?)" });
  const blobUrl = URL.createObjectURL(blob);
  send({ type: "ready", tabId, blobUrl, filename });
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10 * 60 * 1000);
}