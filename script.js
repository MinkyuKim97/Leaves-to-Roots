const USER_ID = "100003083457814";
const BASE_ACTIVITY_URL = `https://www.facebook.com/${USER_ID}/allactivity/?activity_history=false&category_key=COMMENTSCLUSTER&manage_mode=false&should_load_landing_page=false`;

function buildActivityUrlByTs(ts) {
  if (!ts) return BASE_ACTIVITY_URL;
  const dt = new Date(ts * 1000);
  const year = dt.getFullYear();
  const month = dt.getMonth() + 1;
  const u = new URL(BASE_ACTIVITY_URL);
  u.searchParams.set("month", String(month));
  u.searchParams.set("year", String(year));
  return u.toString();
}

let ws,
  items = [],
  selectedIndex = null;

const log = (...a) => {
  const p = document.getElementById("log");
  p.textContent += a.join(" ") + "\n";
  p.scrollTop = p.scrollHeight;
};
function clearLog() {
  const p = document.getElementById("log");
  p.textContent = "";
}

log("[!] Import JSON");
log("[!] Connect with WS");

const escHTML = (s) =>
  s.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[m])
  );

/* ====== FB double-escaped / mojibake decoder ====== */
function unescapeU00Bytes(s) {
  s = s.replace(/\\\\u00([0-9a-fA-F]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
  s = s.replace(/\\u00([0-9a-fA-F]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
  return s;
}
function bytesToUtf8(strWithBytes) {
  const bytes = new Uint8Array(
    [...strWithBytes].map((ch) => ch.charCodeAt(0) & 0xff)
  );
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return strWithBytes;
  }
}
function decodeFbEscapedString(s) {
  const asBytes = unescapeU00Bytes(s);
  return bytesToUtf8(asBytes);
}
function latin1UnitsToUtf8(s) {
  const bytes = new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff));
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return s;
  }
}
function fixDoubleEscapedOrMojibake(s) {
  if (/\\u00[0-9a-fA-F]{2}/.test(s) || /\\\\u00[0-9a-fA-F]{2}/.test(s))
    return decodeFbEscapedString(s);
  if (/[\u00C0-\u00FF]/.test(s)) {
    const rec = latin1UnitsToUtf8(s);
    if (/[\u3130-\u318F\uAC00-\uD7AF]/.test(rec)) return rec;
    return rec;
  }
  return s;
}
// function unescapeU00Bytes(s){
//   s = s.replace(/\\\\u00([0-9a-fA-F]{2})/g, (_,h)=> String.fromCharCode(parseInt(h,16)));
//   s = s.replace(/\\u00([0-9a-fA-F]{2})/g,  (_,h)=> String.fromCharCode(parseInt(h,16)));
//   return s;
// }
// function bytesToUtf8(strWithBytes){
//   const bytes=new Uint8Array([...strWithBytes].map(ch=>ch.charCodeAt(0)&255));
//   try{ return new TextDecoder().decode(bytes); }catch{ return strWithBytes; }
// }
// function fixDoubleEscapedOrMojibake(s){
//   try{
//     const un = unescapeU00Bytes(s);
//     const u8 = bytesToUtf8(un);
//     return u8;
//   }catch{ return s; }
// }
function deepAutoDecode(v) {
  if (typeof v === "string") return fixDoubleEscapedOrMojibake(v);
  if (Array.isArray(v)) return v.map(deepAutoDecode);
  if (v && typeof v === "object") {
    const out = {};
    for (const k in v) out[k] = deepAutoDecode(v[k]);
    return out;
  }
  return v;
}

// Reveal the web side control button
let btnRevealCheck = false;
document.getElementById("btnReveal").onclick = () => {
  if (!btnRevealCheck) {
    document.getElementById("readNFC").style.display = "block";
    document.getElementById("writeSelected").style.display = "block";
    btnRevealCheck = true;
  } else {
    btnRevealCheck = false;
    document.getElementById("readNFC").style.display = "none";
    document.getElementById("writeSelected").style.display = "none";
  }
};
document.getElementById("btnReset").onclick = () => {
  location.reload();
};

// WS port connect & managing msg connection
let wsConnected = false;
let jsonImported = false;
let readWriteState = 0;
document.getElementById("connect").onclick = () => {
  ws = new WebSocket(document.getElementById("url").value);
  ws.onopen = () => {
    log("[O] WS: Connected");
    wsConnected = true;
    if (wsConnected && jsonImported) {
      clearLog();
      log("[O] WS: Connected / JSON: Imported");
    }
    // log("wsConnected: "+wsConnected);
  };
  ws.onclose = () => log("WS CLOSE");
  ws.onerror = (e) => log("WS ERR", e?.message || e);
  ws.onmessage = (ev) => {
    if (!wsConnected || !jsonImported) return;
    log("WS ← ", ev.data);
    try {
      const msg = JSON.parse(ev.data);
      if (
        msg &&
        msg.event === "mode" &&
        (msg.mode === "read" || msg.mode === "write")
        // && wsConnected && jsonImported
      ) {
        document.getElementById("hwmode").textContent = msg.mode;
        if (msg.mode === "read") {
          let readWriteState = 0;
        } else if (msg.mode === "write") {
          let readWriteState = 1;
        }
        return;
      }
      if (
        msg &&
        msg.event === "execute" &&
        (msg.mode === "read" || msg.mode === "write")
      ) {
        if (msg.mode === "read") {
          if (!ws || ws.readyState !== 1) return log("WS not connected");
          ws.send(JSON.stringify({ op: "read" }));
        } else if (msg.mode === "write") {
          if (selectedIndex == null) {
            log("[Write] No JSON selected");
            return;
          }
          const obj = items[selectedIndex];
          const payload = JSON.stringify(obj);
          ws.send(JSON.stringify({ op: "write", json: payload }));
          toast("Staged for write. Press D8 to EXEC.");
          log(
            "WS → stage_write(selected) (bytes=",
            new TextEncoder().encode(payload).length,
            ")"
          );
        }
      }
      if (msg && typeof msg.serial === "string") {
        return;
      }
      // if (msg && typeof msg.info === 'string'){ return; }

      if (
        msg &&
        msg.ok === true &&
        msg.op === "read" &&
        typeof msg.json === "string"
      ) {
        let parsed;
        try {
          parsed = JSON.parse(msg.json);
        } catch {
          renderNfcPreview({ text: fixDoubleEscapedOrMojibake(msg.json) });
          return;
        }
        // log('[Read] JSON Received');
        const cooked = deepAutoDecode(parsed);
        renderNfcPreview(cooked);
        // renderNfcPreview(msg.json);
      }
    } catch {}
  };
};

// document.getElementById("go").onclick = () => {
//   if (!ws || ws.readyState !== 1) return log("WS not connected");
//   ws.send(JSON.stringify({ op: "read" }));
//   log("WS → read (legacy GO)");
// };
document.getElementById("readNFC").onclick = () => {
  if (!wsConnected || !jsonImported) return;
  if (!ws || ws.readyState !== 1) return log("WS not connected");
  ws.send(JSON.stringify({ op: "read" }));
  log("WS → read");
};
document.getElementById("writeSelected").onclick = () => {
  if (!wsConnected || !jsonImported) return;
  if (!ws || ws.readyState !== 1) return log("WS not connected");
  if (selectedIndex == null) return;
  const obj = items[selectedIndex];
  const payload = JSON.stringify(obj);
  ws.send(JSON.stringify({ op: "stage_write", json: payload }));
  toast("Staged for write. Press D8 to EXEC.");
  log(
    "WS → stage_write(selected) (bytes=",
    new TextEncoder().encode(payload).length,
    ")"
  );
};

// function renderNfcPreview(obj) {
//   const el = document.getElementById("preview");
//   el.innerHTML = "<pre>" + escHTML(JSON.stringify(obj, null, 2)) + "</pre>";
// }
function renderNfcPreview(obj) {
  const el = document.getElementById("preview");

  // timestamp → 사람이 읽을 수 있는 시간으로 변환
  let timeStr = "";
  if (obj.timestamp) {
    timeStr = new Date(obj.timestamp * 1000).toLocaleString();
  }

  // author/comment 꺼내기 (data[0].comment.* 기준)
  let author = "";
  let comment = "";
  if (obj.data && obj.data.length > 0 && obj.data[0].comment) {
    author = obj.data[0].comment.author || obj.author || "";
    comment = obj.data[0].comment.comment || obj.comment || "";
  } else {
    // 혹시 루트에 author/comment 직접 있으면 fallback
    author = obj.author || "";
    comment = obj.comment || "";
  }

  // HTML 출력 (필요 항목만)
  el.innerHTML = `
    <div><b>Time:</b> ${escHTML(timeStr)} / <b>Author:</b> ${escHTML(
    author
  )}</div>
    <div>--------</div>
    <div><b>Comment:</b><br> ${escHTML(comment)}</div>
  `;
}

/* ========== JSON import (drag&drop + file input) ========== */
const drop = document.getElementById("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("drag");
});
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("drag");
  if (e.dataTransfer.files?.length) handleFile(e.dataTransfer.files[0]);
});
document.getElementById("file").addEventListener("change", (e) => {
  jsonImported = true;
  log("[O] JSON: Imported");
  if (wsConnected && jsonImported) {
    clearLog();
    log("[O] WS: Connected / JSON: Imported");
  }

  if (e.target.files?.length) handleFile(e.target.files[0]);
});

async function handleFile(file) {
  const text = await file.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    alert("JSON parse error: " + e.message);
    return;
  }

  const rawArr = json.comments_v2 || json.data || json || [];
  if (!Array.isArray(rawArr)) {
    alert("comments_v2 array not found");
    return;
  }

  // normalize
  items = rawArr.map((entry) => {
    let comment = "",
      author = "",
      cts = entry.timestamp || null;
    if (
      Array.isArray(entry.data) &&
      entry.data.length &&
      entry.data[0].comment
    ) {
      const c = entry.data[0].comment;
      comment = typeof c.comment === "string" ? c.comment : "";
      author = c.author || "";
      cts = c.timestamp || entry.timestamp || null;
    }
    const title = entry.title || "";
    const decoded = {
      timestamp: cts || entry.timestamp || null,
      title,
      data: entry.data,
      author,
      comment: fixDoubleEscapedOrMojibake(comment),
      permalink: entry.permalink_url || entry.uri || entry.url || null,
    };
    return decoded;
  });

  renderTable();
}

/* ========== Table render & selection ========== */
document.getElementById("sort").onchange = renderTable;

function renderTable() {
  const sort = document.getElementById("sort").value;
  const arr = [...items];
  if (sort === "time_desc")
    arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  else arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const tb = document.getElementById("tbody");
  tb.innerHTML = "";
  arr.forEach((it) => {
    const tr = document.createElement("tr");
    const idx = items.indexOf(it);

    const dt = new Date((it.timestamp || 0) * 1000);
    const when = isNaN(dt.getTime()) ? "—" : dt.toLocaleString();

    tr.innerHTML = `
      <td><input type="radio" name="pick" value="${idx}"></td>
      <td>${escHTML(when)}</td>
      <td>${escHTML(it.author || "")}</td>
      <td>${escHTML(it.title || "")}</td>
      <td>${escHTML(it.comment || "")}</td>
    `;
    tr.querySelector("input[type=radio]").onchange = () => {
      selectedIndex = idx;
      renderSelected(true);
    };
    tb.appendChild(tr);
  });

  // document.getElementById("count").textContent = items.length;
  selectedIndex = null;
  renderSelected(false);
}

/* === 선택 패널, 링크 할당, 자동 클립보드 복사 === */
function renderSelected(autoCopy) {
  const wrap = document.getElementById("sel");
  const btnWrite = document.getElementById("writeSelected");
  const btnCopy = document.getElementById("copyText");
  const aOpen = document.getElementById("openFb");

  btnWrite.disabled = selectedIndex == null;
  btnCopy.disabled = selectedIndex == null;

  // 기본: 항상 BASE_ACTIVITY_URL
  aOpen.href = BASE_ACTIVITY_URL;
  aOpen.toggleAttribute("disabled", selectedIndex == null);

  if (selectedIndex == null) {
    wrap.textContent = "[Selected Comment Info]";
    return;
  }

  const it = items[selectedIndex];
  const dt = new Date((it.timestamp || 0) * 1000);
  const when = isNaN(dt.getTime()) ? "—" : dt.toLocaleString();

  // ✅ 선택된 항목의 월/연도로 링크 변형
  aOpen.href = buildActivityUrlByTs(it.timestamp);

  wrap.innerHTML = `
    <div class="kvs">
      <b>Time</b><span>${escHTML(when)}</span>
      <b>Author</b><span>${escHTML(it.author || "")}</span>
      <b>Title</b><span>${escHTML(it.title || "")}</span>
      <b>Comment</b><span>${escHTML(it.comment || "")}</span>
    </div>
  `;

  // ✅ 선택 즉시: 댓글 내용만 자동 복사
  if (autoCopy && it.comment) {
    navigator.clipboard
      .writeText(it.comment)
      .then(() => {
        toast("Comment copied to clipboard");
      })
      .catch(() => {
        console.warn("Clipboard write failed");
      });
  }
}

document.getElementById("copyText").onclick = () => {
  if (selectedIndex == null) return;
  const it = items[selectedIndex];
  const txt = it.comment || "";
  if (!txt) {
    toast("No comment text");
    return;
  }
  navigator.clipboard
    .writeText(txt)
    .then(() => toast("Comment copied to clipboard"))
    .catch(() => alert("Clipboard write failed"));
};

/* === Toast === */
function toast(msg) {
  const div = document.createElement("div");
  div.textContent = msg;
  div.style.cssText =
    "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
    "background:#080808;color:#fff;padding:10px 14px;border-radius:8px;" +
    "border: 2px solid #fff;;z-index:9999;font-size:13px;";
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1800);
}