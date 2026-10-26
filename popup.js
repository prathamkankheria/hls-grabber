(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const listEl = document.getElementById("list");
  const statusEl = document.getElementById("status");
  const bar = document.getElementById("bar");
  const nextEl = document.getElementById("next");
  let shownCount = -1;

  const pad = n => String(n).padStart(3, "0") + ".mp4";

  async function updateNext() {
    const { counter = 0 } = await chrome.storage.local.get("counter");
    nextEl.textContent = pad(counter + 1);
  }

  document.getElementById("reset").onclick = async () => {
    await chrome.storage.local.set({ counter: 0 });
    updateNext();
  };

  function pretty(url) {
    try { return decodeURIComponent(url); } catch { return url; }
  }

  function renderStreams(streams) {
    listEl.innerHTML = "";
    if (!streams.length) {
      listEl.innerHTML = '<div class="empty">No streams detected.<br>Play the video first.</div>';
      return;
    }
    streams.forEach(s => {
      const full = pretty(s.url);
      const q = full.match(/(\d{3,4})p\d*/);   // e.g. 480p30 -> "480p"

      const card = document.createElement("div");
      card.className = "card";
      card.title = full;

      const row = document.createElement("div");
      row.className = "row";

      const badge = document.createElement("div");
      badge.className = "badge" + (q ? "" : " unk");
      badge.textContent = q ? q[1] + "p" : "?";

      const marq = document.createElement("div");
      marq.className = "marq";
      const span = document.createElement("span");
      span.textContent = full;
      marq.appendChild(span);

      const dl = document.createElement("div");
      dl.className = "dl";
      dl.textContent = "⬇ Download";

      row.append(badge, marq, dl);
      card.appendChild(row);
      listEl.appendChild(card);

      // enable scrolling only if the text doesn't fit
      requestAnimationFrame(() => {
        if (span.scrollWidth > marq.clientWidth) {
          marq.style.setProperty("--d", Math.max(8, full.length * 0.14) + "s");
          marq.classList.add("scroll");
        }
      });

      card.onclick = () => chrome.runtime.sendMessage({
        type: "start", url: s.url, tabId: tab.id, referer: tab.url, title: tab.title
      });
    });
  }

  async function refresh() {
    const { streams, progress } = await chrome.runtime.sendMessage({ type: "list", tabId: tab.id });
    if (streams.length !== shownCount) { shownCount = streams.length; renderStreams(streams); }

    if (progress) {
      const st = progress.status || "";
      statusEl.textContent = st + (progress.total > 1 ? ` (${progress.done}/${progress.total})` : "");
      statusEl.className = st.startsWith("Error") ? "err" : st.startsWith("Done") ? "ok" : "";
      bar.style.display = progress.total > 1 ? "block" : "none";
      bar.max = progress.total || 1;
      bar.value = progress.done;
    }
    updateNext();
  }

  refresh();
  setInterval(refresh, 500);
})();