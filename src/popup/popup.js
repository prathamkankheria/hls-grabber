(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const listEl = document.getElementById("list");
  const jobsEl = document.getElementById("jobs");
  const nextEl = document.getElementById("next");

  let shownCount = -1;
  let currentStreams = [];
  let cards = [];              // [{url, dl}]
  const jobEls = new Map();    // jobId -> {el, state, txt, bar}

  const pad = n => String(n).padStart(3, "0") + ".mp4";
  const pretty = u => { try { return decodeURIComponent(u); } catch { return u; } };
  const quality = u => { const m = pretty(u).match(/(\d{3,4})p\d*/); return m ? m[1] + "p" : null; };

  function enqueue(s) {
    return chrome.runtime.sendMessage({
      type: "enqueue", url: s.url, referer: tab.url, title: tab.title, tabId: tab.id
    });
  }

  document.getElementById("queueAll").onclick = async () => {
    for (const s of currentStreams) await enqueue(s);
    refresh();
  };
  document.getElementById("clear").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "clear", tabId: tab.id });
    jobEls.forEach(j => j.el.remove());
    jobEls.clear();
    refresh();
  };
  document.getElementById("reset").onclick = async () => {
    await chrome.storage.local.set({ counter: 0 });
    updateNext();
  };

  async function updateNext() {
    const { counter = 0 } = await chrome.storage.local.get("counter");
    nextEl.textContent = pad(counter + 1);
  }

  function renderStreams(streams) {
    listEl.innerHTML = "";
    cards = [];
    if (!streams.length) {
      listEl.innerHTML = '<div class="empty">No streams detected.<br>Play the video first.</div>';
      return;
    }
    streams.forEach(s => {
      const full = pretty(s.url);
      const q = quality(s.url);

      const card = document.createElement("div");
      card.className = "card";
      card.title = full;
      const row = document.createElement("div");
      row.className = "row";

      const badge = document.createElement("div");
      badge.className = "badge" + (q ? "" : " unk");
      badge.textContent = q || "?";

      const marq = document.createElement("div");
      marq.className = "marq";
      const span = document.createElement("span");
      span.textContent = full;
      marq.appendChild(span);

      const dl = document.createElement("div");
      dl.className = "dl";
      dl.textContent = "+ Queue";

      row.append(badge, marq, dl);
      card.appendChild(row);
      listEl.appendChild(card);
      cards.push({ url: s.url, dl });

      requestAnimationFrame(() => {
        if (span.scrollWidth > marq.clientWidth) {
          marq.style.setProperty("--d", Math.max(8, full.length * 0.14) + "s");
          marq.classList.add("scroll");
        }
      });

      card.onclick = async () => { await enqueue(s); refresh(); };
    });
  }

  function renderJobs(jobs) {
    // create missing rows, update existing ones in place (no flicker)
    jobs.forEach((j, idx) => {
      let r = jobEls.get(j.id);
      if (!r) {
        const el = document.createElement("div");
        const row = document.createElement("div");
        row.className = "row";
        const badge = document.createElement("div");
        const q = quality(j.url);
        badge.className = "badge" + (q ? "" : " unk");
        badge.textContent = q || "?";
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = pretty(j.url);
        name.title = pretty(j.url);
        const state = document.createElement("div");
        state.className = "state";
        const cancel = document.createElement("button");
        cancel.className = "ghost small";
        cancel.textContent = "✕";
        cancel.title = "Cancel";
        cancel.onclick = async () => {
          await chrome.runtime.sendMessage({ type: "cancel", jobId: j.id });
          refresh();
        };
        row.append(badge, name, state, cancel);
        const bar = document.createElement("progress");
        const txt = document.createElement("div");
        txt.className = "txt";
        el.append(row, bar, txt);
        jobsEl.appendChild(el);
        r = { el, state, txt, bar, cancel };
        jobEls.set(j.id, r);
      }
      r.el.className = "job " + j.status;
      r.cancel.style.display = j.status === "queued" || j.status === "running" ? "" : "none";
      r.state.textContent = { queued: "queued", running: "running", done: "done ✔", error: "failed", cancelled: "cancelled" }[j.status];
      r.txt.textContent = j.text + (j.status === "running" && j.total > 1 ? ` (${j.done}/${j.total})` : "");
      r.bar.style.display = j.status === "running" && j.total > 1 ? "block" : "none";
      r.bar.max = j.total || 1;
      r.bar.value = j.done;
    });

    // drop rows for jobs that were removed (e.g. cancelled while queued)
    const ids = new Set(jobs.map(j => j.id));
    jobEls.forEach((r, id) => { if (!ids.has(id)) { r.el.remove(); jobEls.delete(id); } });

    if (!jobs.length) jobsEl.innerHTML = '<div class="empty">Nothing queued yet.</div>';
    else jobsEl.querySelector(".empty")?.remove();

    // mark cards that are already in the queue
    cards.forEach(c => {
      const inQ = jobs.some(j => j.url === c.url && j.status !== "error" && j.status !== "cancelled");
      c.dl.textContent = inQ ? "✔ In queue" : "+ Queue";
      c.dl.classList.toggle("in", inQ);
    });
  }

  async function refresh() {
    const { streams, jobs } = await chrome.runtime.sendMessage({ type: "list", tabId: tab.id });
    currentStreams = streams;
    if (streams.length !== shownCount) { shownCount = streams.length; renderStreams(streams); }
    renderJobs(jobs);
    updateNext();
  }

  refresh();
  setInterval(refresh, 500);
})();