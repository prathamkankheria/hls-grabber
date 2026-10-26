const DEBUG_RAW_TS = false;
const CONCURRENCY = 8;
let current = null; // {jobId}

const send = m => chrome.runtime.sendMessage(m).catch(() => {});
const abs = (u, base) => new URL(u, base).href;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== "process") return;
  current = { jobId: msg.jobId };
  run(msg.url).catch(e => send({ type: "error", jobId: msg.jobId, error: String(e.message || e) }));
  reply({ ok: true });
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

function stripToTS(u8) {
  for (let i = 0; i < Math.min(u8.length, 4096); i++)
    if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) return i ? u8.subarray(i) : u8;
  return u8;
}

let ff = null;
async function getFF() {
  if (ff) return ff;
  const f = new FFmpegWASM.FFmpeg();
  await f.load({
    coreURL: chrome.runtime.getURL("ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("ffmpeg-core.wasm"),
    classWorkerURL: chrome.runtime.getURL("814.ffmpeg.js")
  });
  ff = f;
  return ff;
}

async function remux(results) {
  let total = 0;
  for (const r of results) total += r.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const r of results) { all.set(r, off); off += r.length; }
  results.length = 0;

  const f = await getFF();
  try {
    await f.writeFile("in.ts", all);
    const code = await f.exec([
      "-i", "in.ts",
      "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "+faststart",
      "out.mp4"
    ]);
    if (code !== 0) throw new Error("ffmpeg failed with code " + code);
    const out = await f.readFile("out.mp4");
    return new Blob([out], { type: "video/mp4" });
  } finally {
    // always clean up so the next queued job starts with an empty filesystem
    await f.deleteFile("in.ts").catch(() => {});
    await f.deleteFile("out.mp4").catch(() => {});
  }
}

async function run(m3u8Url) {
  const { jobId } = current;
  const report = (done, total, status) => send({ type: "progress", jobId, done, total, status });

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

  if (initData) {
    report(done, segs.length, "Saving…");
    finish(new Blob([initData, ...results], { type: "video/mp4" }), "mp4", jobId);
    return;
  }

  if (DEBUG_RAW_TS) {
    report(done, segs.length, "Saving raw .ts…");
    finish(new Blob(results, { type: "video/mp2t" }), "ts", jobId);
    return;
  }

  report(done, segs.length, "Converting to MP4…");
  finish(await remux(results), "mp4", jobId);
}

function finish(blob, ext, jobId) {
  if (!blob.size) return send({ type: "error", jobId, error: "Output is empty (unsupported codec/format?)" });
  const blobUrl = URL.createObjectURL(blob);
  send({ type: "ready", jobId, blobUrl, ext });
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10 * 60 * 1000);
}