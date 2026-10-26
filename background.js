const streams = {};   // tabId -> [{url}]
const progress = {};  // tabId -> {done, total, status}

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

chrome.tabs.onRemoved.addListener(id => { delete streams[id]; delete progress[id]; });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading" && info.url) { // navigation: reset
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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "list") {
    reply({ streams: streams[msg.tabId] || [], progress: progress[msg.tabId] || null });
    return;
  }
  if (msg.type === "start") {
    (async () => {
      progress[msg.tabId] = { done: 0, total: 0, status: "Starting…" };
      await setHeaderRule(msg.url, msg.referer);
      await ensureOffscreen();
      chrome.runtime.sendMessage({
        type: "process", url: msg.url, tabId: msg.tabId, title: msg.title
      }).catch(() => {});
    })();
    return;
  }
  if (msg.type === "progress") {
    progress[msg.tabId] = { done: msg.done, total: msg.total, status: msg.status };
    return;
  }
  if (msg.type === "ready") {
    (async () => {
      const { counter = 0 } = await chrome.storage.local.get("counter");
      const n = counter + 1;
      await chrome.storage.local.set({ counter: n });
      const filename = String(n).padStart(3, "0") + "." + (msg.ext || "mp4");
      chrome.downloads.download({ url: msg.blobUrl, filename, saveAs: false });
      progress[msg.tabId] = { done: 1, total: 1, status: "Done ✔ saved as " + filename };
    })();
    return;
  }
  if (msg.type === "error") {
    progress[msg.tabId] = { done: 0, total: 0, status: "Error: " + msg.error };
  }
});