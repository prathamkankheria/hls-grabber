const DEBUG_RAW_TS = false;
const CONCURRENCY = 8;
let current = null;

const send = m => chrome.runtime.sendMessage(m).catch(() => {});
const abs = (u, base) => new URL(u, base).href;

const controllers = new Map(); // jobId -> AbortController

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "abort") { controllers.get(msg.jobId)?.abort(); return; }
  if (msg.type !== "process") return;
  const ctl = new AbortController();
  controllers.set(msg.jobId, ctl);
  run(msg.url, msg.jobId, ctl.signal)
    .catch(e => { if (!ctl.signal.aborted) send({ type: "error", jobId: msg.jobId, error: String(e.message || e) }); })
    .finally(() => controllers.delete(msg.jobId));
  reply({ ok: true });
});

async function getText(url, signal) {
  const r = await fetch(url, { credentials: "include", signal });
  if (!r.ok) throw new Error(`Playlist HTTP ${r.status}`);
  return r.text();
}

async function fetchRetry(url, signal, tries = 4) {
  for (let i = 0; i < tries; i++) {
    signal.throwIfAborted();
    try {
      const r = await fetch(url, { credentials: "include", signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(-60)}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (signal.aborted || i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function pool(n, limit, fn, signal) {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < n) { signal.throwIfAborted(); await fn(next++); }
  }));
}

async function resolveMedia(url, signal) {
  const text = await getText(url, signal);
  if (!text.includes("#EXT-X-STREAM-INF")) return { url, text };
  const lines = text.split("\n").map(l => l.trim());
  let best = { bw: -1, uri: null, attrs: "" };
  lines.forEach((l, i) => {
    const m = l.match(/BANDWIDTH=(\d+)/);
    if (l.startsWith("#EXT-X-STREAM-INF") && m && +m[1] > best.bw) best = { bw: +m[1], uri: lines[i + 1], attrs: l };
  });
  const video = await resolveMedia(abs(best.uri, url), signal);

  // separate audio rendition referenced by the chosen variant
  const group = /AUDIO="([^"]+)"/.exec(best.attrs)?.[1];
  if (group) {
    const renditions = lines.filter(l => l.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(l) &&
      l.includes(`GROUP-ID="${group}"`) && /URI="/.test(l));
    const pick = renditions.find(l => /DEFAULT=YES/.test(l)) || renditions[0];
    if (pick) {
      const audio = await resolveMedia(abs(/URI="([^"]+)"/.exec(pick)[1], url), signal);
      return { ...video, audio };
    }
  }
  return video;
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

// each job gets its own ffmpeg instance so conversions can run in parallel
async function newFF() {
  const f = new FFmpegWASM.FFmpeg();
  await f.load({
    coreURL: chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.wasm"),
    classWorkerURL: chrome.runtime.getURL("lib/ffmpeg/814.ffmpeg.js")
  });
  return f;
}

const concat = parts => {
  let total = 0;
  for (const r of parts) total += r.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const r of parts) { all.set(r, off); off += r.length; }
  return all;
};

// inputs: [{name, data}] - one input is remuxed to mp4, two are muxed (video + separate audio)
async function remux(inputs, signal) {
  const f = await newFF();
  const onAbort = () => { try { f.terminate(); } catch {} };
  signal.addEventListener("abort", onAbort);
  try {
    signal.throwIfAborted();
    for (const i of inputs) { await f.writeFile(i.name, i.data); i.data = null; }
    const maps = inputs.length > 1 ? ["-map", "0:v:0", "-map", "1:a:0"] : [];
    const code = await f.exec([
      ...inputs.flatMap(i => ["-i", i.name]),
      ...maps,
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
    signal.removeEventListener("abort", onAbort);
    try { f.terminate(); } catch {}
  }
}

async function downloadTrack(track, signal, onSegment) {
  const { segs, map } = track;
  const results = new Array(segs.length);
  const keyCache = new Map();
  const initData = map ? await fetchRetry(map, signal) : null;

  await pool(segs.length, CONCURRENCY, async i => {
    const s = segs[i];
    let data = await fetchRetry(s.url, signal);
    if (s.key) {
      if (!keyCache.has(s.key.uri)) {
        keyCache.set(s.key.uri, fetchRetry(s.key.uri, signal).then(raw =>
          crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"])));
      }
      const ck = await keyCache.get(s.key.uri);
      let iv;
      if (s.key.iv) iv = hexToBytes(s.key.iv);
      else { iv = new Uint8Array(16); new DataView(iv.buffer).setUint32(12, s.seq); }
      data = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, data));
    }
    results[i] = initData ? data : stripToTS(data);
    onSegment();
  }, signal);

  return { parts: initData ? [initData, ...results] : results, fmp4: !!initData };
}

async function run(m3u8Url, jobId, signal) {
  const report = (done, total, status) => { if (!signal.aborted) send({ type: "progress", jobId, done, total, status }); };

  report(0, 0, "Reading playlist…");
  const resolved = await resolveMedia(m3u8Url, signal);
  const tracks = [parseMedia(resolved)];
  if (resolved.audio) tracks.push(parseMedia(resolved.audio));
  if (tracks.some(t => !t.segs.length)) throw new Error("No segments found in playlist");

  const total = tracks.reduce((n, t) => n + t.segs.length, 0);
  let done = 0;
  const label = !tracks[0].ended ? "Downloading (live/incomplete stream)…" :
    tracks.length > 1 ? "Downloading video + audio…" : "Downloading…";
  report(0, total, label);

  // video and audio download at the same time
  const downloaded = await Promise.all(tracks.map(t =>
    downloadTrack(t, signal, () => report(++done, total, label))));

  if (downloaded.length === 1 && downloaded[0].fmp4) {
    report(done, total, "Saving…");
    finish(new Blob(downloaded[0].parts, { type: "video/mp4" }), "mp4", jobId);
    return;
  }

  if (DEBUG_RAW_TS && downloaded.length === 1) {
    report(done, total, "Saving raw .ts…");
    finish(new Blob(downloaded[0].parts, { type: "video/mp2t" }), "ts", jobId);
    return;
  }

  report(done, total, downloaded.length > 1 ? "Merging video + audio…" : "Converting to MP4…");
  const inputs = downloaded.map((d, i) => ({
    name: (i ? "audio" : "video") + (d.fmp4 ? ".mp4" : ".ts"),
    data: concat(d.parts)
  }));
  downloaded.forEach(d => { d.parts.length = 0; });
  const mp4 = await remux(inputs, signal);
  signal.throwIfAborted();
  finish(mp4, "mp4", jobId);
}

function finish(blob, ext, jobId) {
  if (!blob.size) return send({ type: "error", jobId, error: "Output is empty (unsupported codec/format?)" });
  const blobUrl = URL.createObjectURL(blob);
  send({ type: "ready", jobId, blobUrl, ext });
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10 * 60 * 1000);
}