importScripts("mux.min.js");

onmessage = e => {
  const tx = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
  const parts = []; let gotInit = false;
  tx.on("data", seg => {
    if (!gotInit) { parts.push(seg.initSegment); gotInit = true; }
    parts.push(seg.data);
  });
  tx.on("done", () => postMessage(new Blob(parts, { type: "video/mp4" })));
  e.data.forEach(buf => tx.push(buf));
  tx.flush();
};