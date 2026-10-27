const streams = {};   // tabId -> [{url}]
let jobs = [];        // global queue: {id, url, referer, title, status, done, total, text}
let nextId = 1;
const MAX_PARALLEL = 3;
const lastTitle = {}; // tabId -> name of the last clicked item (survives page navigation)
const titlesReady = chrome.storage.session.get("lastTitle").then(r => Object.assign(lastTitle, r.lastTitle || {}));
const saveTitles = () => chrome.storage.session.set({ lastTitle });

// a video opened in a new tab inherits the title from the tab that opened it
chrome.tabs.onCreated.addListener(async t => {
  await titlesReady;
  if (t.openerTabId != null && lastTitle[t.openerTabId]) { lastTitle[t.id] = lastTitle[t.openerTabId]; saveTitles(); }
});

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

chrome.tabs.onRemoved.addListener(id => { delete streams[id]; delete lastTitle[id]; saveTitles(); });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading" && info.url) {
    streams[id] = [];
    chrome.action.setBadgeText({ tabId: id, text: "" });
  }
});

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "src/offscreen/offscreen.html",
    reasons: ["BLOBS"],
    justification: "Assemble video segments into a file"
  });
}

async function setHeaderRule(id, streamUrl, referer) {
  const host = new URL(streamUrl).hostname;
  const parent = host.split(".").slice(-2).join(".");
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id, priority: 1,
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
  if (job.status !== "running") return;
  job.status = status;
  job.text = text;
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [job.id] }).catch(() => {});
  pump();
}

function pump() {
  let job;
  while (jobs.filter(j => j.status === "running").length < MAX_PARALLEL && (job = jobs.find(j => j.status === "queued"))) {
    startJob(job);
  }
}

function startJob(job) {
  job.status = "running";
  job.text = "Starting…";
  job.updated = Date.now();
  (async () => {
    try {
      await setHeaderRule(job.id, job.url, job.referer);
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

    case "clickedTitle":
      titlesReady.then(() => {
        if (_sender.tab) { lastTitle[_sender.tab.id] = msg.title; saveTitles(); }
      });
      return;

    case "enqueue":
      titlesReady.then(() => {
        if (jobs.some(j => j.url === msg.url && (j.status === "queued" || j.status === "running"))) return;
        jobs.push({
          id: nextId++, tabId: msg.tabId, url: msg.url, referer: msg.referer,
          title: lastTitle[msg.tabId] || msg.title || "", named: !!lastTitle[msg.tabId],
          status: "queued", done: 0, total: 0, text: "Waiting…"
        });
        pump();
        reply();
      });
      return true;

    case "clear": // remove this tab's finished/waiting jobs, keep running ones
      jobs = jobs.filter(j => j.tabId !== msg.tabId || j.status === "running");
      return;

    case "cancel":
      if (!job) return;
      if (job.status === "queued") jobs = jobs.filter(j => j !== job);
      else if (job.status === "running") {
        endJob(job, "cancelled", "Cancelled");
        chrome.runtime.sendMessage({ type: "abort", jobId: job.id }).catch(() => {});
      }
      return;

    case "progress":
      if (job && job.status === "running") { job.done = msg.done; job.total = msg.total; job.text = msg.status; job.updated = Date.now(); }
      return;

    case "ready":
      if (!job || job.status !== "running") return;
      (async () => {
        const ext = msg.ext || "mp4";
        let filename;
        const clean = job.named
          ? job.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).replace(/[. ]+$/, "")
          : "";
        if (clean) {
          filename = clean + "." + ext;
        } else {
          const { counter = 0 } = await chrome.storage.local.get("counter");
          const n = counter + 1;
          await chrome.storage.local.set({ counter: n });
          filename = String(n).padStart(3, "0") + "." + ext;
        }
        chrome.downloads.download({ url: msg.blobUrl, filename, saveAs: false, conflictAction: "uniquify" });
        job.done = job.total || 1;
        endJob(job, "done", "Saved as " + filename);
      })();
      return;

    case "error":
      if (job) endJob(job, "error", msg.error);
      return;
  }
});