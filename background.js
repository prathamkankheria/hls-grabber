const streams = {};   // tabId -> [{url}]
let jobs = [];        // global queue: {id, url, referer, title, status, done, total, text}
let nextId = 1;
let running = false;

function addStream(d) {
  if (d.tabId < 0) return;
  const list = (streams[d.tabId] ||= []);
  if (!list.some(s => s.url === d.url)) list.push({ url: d.url });
  chrome.action.setBadgeText({ tabId: d.tabId, text: String(list.length) });
}

chrome.webRequest.onHeadersReceived.addListener(d => {
  const ct = (d.responseHeaders?.find(h => h.name.toLowerCase() === "content-type")?.value || "").toLowerCase();
  if (/\.m3u8/i.test(d.url) || ct.includes("mpegurl")) addStream(d);
}, { urls: ["<all_urls>"] }, ["responseHeaders"]);

chrome.tabs.onRemoved.addListener(id => { delete streams[id]; });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading" && info.url) {
    streams[id] = [];
    chrome.action.setBadgeText({ tabId: id, text: "" });
  }
});

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Assemble video segments into a file"
  });
}

async function setHeaderRule(streamUrl, referer) {
  const host = new URL(streamUrl).hostname;
  const parent = host.split(".").slice(-2).join(".");
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1, priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: referer },
          { header: "origin", operation: "set", value: new URL(referer).origin }
        ]
      },
      condition: {
        requestDomains: [...new Set([host, parent])],
        resourceTypes: ["xmlhttprequest", "other"]
      }
    }]
  });
}

function endJob(job, status, text) {
  job.status = status;
  job.text = text;
  running = false;
  pump();
}

function pump() {
  if (running) return;
  const job = jobs.find(j => j.status === "queued");
  if (!job) return;
  running = true;
  job.status = "running";
  job.text = "Starting…";
  job.updated = Date.now();
  (async () => {
    try {
      await setHeaderRule(job.url, job.referer);
      await ensureOffscreen();
      // the offscreen document may not have registered its listener yet, so retry until it acks
      let acked = false;
      for (let i = 0; i < 40 && !acked; i++) {
        try {
          acked = !!(await chrome.runtime.sendMessage({ type: "process", url: job.url, jobId: job.id }))?.ok;
        } catch {}
        if (!acked) await new Promise(r => setTimeout(r, 250));
      }
      if (!acked) throw new Error("Could not reach the converter page");
      job.updated = Date.now();
    } catch (e) {
      endJob(job, "error", String(e.message || e));
    }
  })();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const job = msg.jobId ? jobs.find(j => j.id === msg.jobId) : null;

  switch (msg.type) {
    case "list": {
      // watchdog: a running job with no progress for 2 minutes would block the queue forever
      const stuck = jobs.find(j => j.status === "running" && Date.now() - (j.updated || 0) > 120000);
      if (stuck && stuck.updated) endJob(stuck, "error", "Timed out (no progress)");
      // downloads from other tabs keep running in the background but are hidden here
      reply({ streams: streams[msg.tabId] || [], jobs: jobs.filter(j => j.tabId === msg.tabId) });
      return;
    }

    case "enqueue":
      if (!jobs.some(j => j.url === msg.url && (j.status === "queued" || j.status === "running"))) {
        jobs.push({
          id: nextId++, tabId: msg.tabId, url: msg.url, referer: msg.referer, title: msg.title || "",
          status: "queued", done: 0, total: 0, text: "Waiting…"
        });
        pump();
      }
      return;

    case "clear": // remove this tab's finished/waiting jobs, keep running ones
      jobs = jobs.filter(j => j.tabId !== msg.tabId || j.status === "running");
      return;

    case "progress":
      if (job) { job.done = msg.done; job.total = msg.total; job.text = msg.status; job.updated = Date.now(); }
      return;

    case "ready":
      if (!job) return;
      (async () => {
        const { counter = 0 } = await chrome.storage.local.get("counter");
        const n = counter + 1;
        await chrome.storage.local.set({ counter: n });
        const filename = String(n).padStart(3, "0") + "." + (msg.ext || "mp4");
        chrome.downloads.download({ url: msg.blobUrl, filename, saveAs: false });
        job.done = job.total || 1;
        endJob(job, "done", "Saved as " + filename);
      })();
      return;

    case "error":
      if (job) endJob(job, "error", msg.error);
      return;
  }
});