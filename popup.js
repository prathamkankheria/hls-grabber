(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const items = await chrome.runtime.sendMessage({ type: "list", tabId: tab.id });
  const el = document.getElementById("list");
  el.innerHTML = items.length ? "" : "No streams detected. Play the video first.";
  items.forEach(s => {
    const b = document.createElement("button");
    b.textContent = "Download: " + s.url.slice(0, 50) + "…";
    b.style.cssText = "display:block;width:100%;margin:4px 0";
    b.onclick = () => { chrome.runtime.sendMessage({ type: "start", url: s.url, referer: tab.url }); b.textContent = "Working…"; };
    el.appendChild(b);
  });
})();