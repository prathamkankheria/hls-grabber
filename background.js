const streams = {}; // tabId -> [{url, title}]

chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.tabId < 0 || !/\.m3u8(\?|$)/i.test(d.url)) return;
  const list = (streams[d.tabId] ||= []);
  if (!list.some(s => s.url === d.url)) list.push({ url: d.url });
  chrome.action.setBadgeText({ tabId: d.tabId, text: String(list.length) });
}, { urls: ["<all_urls>"] });

chrome.tabs.onRemoved.addListener(id => delete streams[id]);

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Assemble video segments into a file"
  });
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type === "list") reply(streams[msg.tabId] || []);
  if (msg.type === "start") {
    ensureOffscreen().then(() =>
      chrome.runtime.sendMessage({ type: "process", url: msg.url, referer: msg.referer }));
  }
  if (msg.type === "ready") { // offscreen finished -> auto-download
    chrome.downloads.download({ url: msg.blobUrl, filename: msg.filename, saveAs: false });
  }
  return true;
});