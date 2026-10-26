(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const el = document.getElementById("list");
  const status = document.getElementById("status");
  const bar = document.getElementById("bar");
  let rendered = false;

  async function refresh() {
    const { streams, progress } = await chrome.runtime.sendMessage({ type: "list", tabId: tab.id });
    if (!rendered) {
      rendered = true;
      el.innerHTML = streams.length ? "" : "No streams detected. Play the video first.";
      streams.forEach(s => {
        const b = document.createElement("button");
        b.textContent = "Download: " + s.url.slice(0, 55) + "…";
        b.style.cssText = "display:block;width:100%;margin:4px 0";
        b.onclick = () => chrome.runtime.sendMessage({
          type: "start", url: s.url, tabId: tab.id, referer: tab.url, title: tab.title
        });
        el.appendChild(b);
      });
    }
    if (progress) {
      status.textContent = progress.status + (progress.total > 1 ? ` (${progress.done}/${progress.total})` : "");
      bar.style.display = progress.total > 1 ? "block" : "none";
      bar.max = progress.total || 1;
      bar.value = progress.done;
    }
  }
  refresh();
  setInterval(refresh, 500);
})();