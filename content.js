// Remembers the title of the item (card) the user last clicked on the page.
const SELECTORS = ['[class*="ClassName" i]', '[class*="class-name" i]'];

function findTitle(start) {
  let el = start;
  for (let depth = 0; el && el !== document.body && depth < 8; depth++, el = el.parentElement) {
    for (const sel of SELECTORS) {
      const t = el.matches(sel) ? el : el.querySelector(sel);
      if (!t) continue;
      const text = (t.getAttribute("title") || t.textContent || "").trim().replace(/\s+/g, " ");
      if (text.length > 2 && text.length < 200) return text;
    }
  }
  return "";
}

document.addEventListener("click", e => {
  const title = findTitle(e.target);
  if (title) chrome.runtime.sendMessage({ type: "clickedTitle", title }).catch(() => {});
}, true);
