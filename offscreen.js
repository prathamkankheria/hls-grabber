const CONCURRENCY = 8;
const worker = new Worker("mux-worker.js");

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === "process") run(msg.url).catch(console.error);
});

const abs = (u, base) => new URL(u, base).href;

async function getText(url) { return (await fetch(url)).text(); }

async function fetchRetry(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
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
  // master playlist: pick highest bandwidth
  const lines = text.split("\n").map(l => l.trim());
  let best = { bw: -1, uri: null };
  lines.forEach((l, i) => {
    const m = l.match(/BANDWIDTH=(\d+)/);
    if (l.startsWith("#EXT-X-STREAM-INF") && m && +m[1] > best.bw)
      best = { bw: +m[1], uri: lines[i + 1] };
  });
  return resolveMedia(abs(best.uri, url));
}

function parseMedia({ url, text }) {
  const segs = []; let key = null, seq = 0;
  const lines = text.split("\n").map(l => l.trim());
  const ms = lines.find(l => l.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  if (ms) seq = +ms.split(":")[1];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-KEY")) {
      const method = /METHOD=([^,]+)/.exec(l)[1];
      key = method === "NONE" ? null : {
        uri: abs(/URI="([^"]+)"/.exec(l)[1], url),
        iv: (/IV=0x([0-9a-f]+)/i.exec(l) || [])[1]
      };
    } else if (l && !l.startsWith("#")) {
      segs.push({ url: abs(l, url), key, seq: seq++ });
    }
  }
  return segs;
}

const hexToBytes = h => Uint8Array.from(h.padStart(32, "0").match(/../g), b => parseInt(b, 16));

async function run(m3u8Url) {
  const segs = parseMedia(await resolveMedia(m3u8Url));
  const results = new Array(segs.length);
  const keyCache = new Map();

  await pool(segs.length, CONCURRENCY, async i => {
    const s = segs[i];
    let data = await fetchRetry(s.url);
    if (s.key) {
      if (!keyCache.has(s.key.uri)) {
        keyCache.set(s.key.uri, fetchRetry(s.key.uri).then(raw =>
          crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"])));
      }
      const ck = await keyCache.get(s.key.uri);
      const iv = s.key.iv ? hexToBytes(s.key.iv)
                          : new Uint8Array(new DataView(new ArrayBuffer(16)).buffer); // fallback below
      if (!s.key.iv) new DataView(iv.buffer).setUint32(12, s.seq);
      data = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, data));
    }
    results[i] = data;
  });

  // transfer buffers to worker for remux
  worker.onmessage = e => {
    const blobUrl = URL.createObjectURL(new Blob([e.data], { type: "video/mp4" }));
    chrome.runtime.sendMessage({ type: "ready", blobUrl, filename: `video_${Date.now()}.mp4` });
  };
  worker.postMessage(results, results.map(r => r.buffer));
}