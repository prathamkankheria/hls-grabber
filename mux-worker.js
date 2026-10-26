importScripts("mux.min.js");

// Overwrite mux.js's placeholder durations with the real one
function setDurations(init, seconds) {
  const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const tag = i => String.fromCharCode(init[i], init[i + 1], init[i + 2], init[i + 3]);
  let movieTs = 1000;
  for (let i = 4; i < init.length - 28; i++) {
    const t = tag(i);
    if (init[i + 4] !== 0) continue;               // version 0 boxes only
    if (t === "mvhd") {
      movieTs = dv.getUint32(i + 16);
      dv.setUint32(i + 20, Math.round(seconds * movieTs));
    } else if (t === "tkhd") {
      dv.setUint32(i + 24, Math.round(seconds * movieTs));
    } else if (t === "mdhd") {
      dv.setUint32(i + 20, Math.round(seconds * dv.getUint32(i + 16)));
    }
  }
}

onmessage = e => {
  const { segs, duration } = e.data;
  const tx = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false, baseMediaDecodeTime: 0 });
  const parts = []; let gotInit = false;

  tx.on("data", seg => {
    if (!gotInit) {
      console.log("mux.js tracks:", (seg.tracks || []).map(t => t.type + " " + (t.codec || "")));
      if (duration) setDurations(seg.initSegment, duration);
      parts.push(seg.initSegment); gotInit = true;
    }
    parts.push(seg.data);
  });
  tx.on("done", () => postMessage(new Blob(parts, { type: "video/mp4" })));

  segs.forEach(buf => tx.push(buf));
  tx.flush();
};