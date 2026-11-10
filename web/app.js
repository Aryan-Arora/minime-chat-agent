// MiniMe chat UI. Vanilla ES module, no dependencies.
// Flow: send() -> POST /api/chat -> read SSE stream -> update the DOM per event.

const $ = (id) => document.getElementById(id);
const list = $("messages"), input = $("input"), sendBtn = $("send");

// ---------- conversation id ----------
// The server keys memory by this id, so it must survive page reloads.
// localStorage can throw (private mode, blocked storage), so fall back to a per-load id.
const KEY = "minime.conversationId";
function loadId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}
let conversationId = loadId();

// ---------- tiny safe markdown ----------
// Safety strategy: escape ALL html first, then add only tags we generate ourselves.
// Since "<" is already "&lt;", model output can never inject markup.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(raw) {
  let s = esc(raw);
  // Pull code spans out first so **bold**/links inside backticks stay literal.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Only http(s) links: blocks javascript: URLs. Quotes were escaped so href can't be broken out of.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function markdown(text) {
  const out = [];
  let para = [], items = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => { if (items.length) out.push(`<ul>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`); items = []; };
  for (const line of text.split("\n")) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { flushPara(); items.push(bullet[1]); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join("");
}

// ---------- DOM helpers ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text; // textContent, never innerHTML, for anything not markdown
  list.appendChild(e);
  return e;
}

function detailBox(label, emptyText) {
  const details = document.createElement("details");
  details.className = "trace";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const body = document.createElement("div");
  body.className = "trace-body empty";
  body.textContent = emptyText;
  details.append(summary, body);
  list.appendChild(details);
  return { details, body };
}
// Only scroll if the user is already near the bottom, so they can read earlier text mid-stream.
function scroll(force) {
  if (force || list.scrollHeight - list.scrollTop - list.clientHeight < 120) list.scrollTop = list.scrollHeight;
}

// ---------- sending ----------
let streaming = false;
let lastMessage = ""; // kept so Retry can resend

async function send(message) {
  if (streaming || !message.trim()) return;
  streaming = true; sendBtn.disabled = true;
  lastMessage = message;

  el("div", "msg user", message);
  const bot = el("div", "msg bot");
  bot.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; // typing indicator
  const activity = detailBox("Activity", "Waiting for the agent…");
  const context = detailBox("Memory context", "No memory context was reported for this answer.");
  list.insertBefore(activity.details, bot);
  list.insertBefore(context.details, bot);
  let status = el("div", "status", "Connecting…"), text = "", gotToken = false, finished = false;
  list.insertBefore(status, activity.details);
  scroll(true);

  const addTrace = (box, value) => {
    if (box.classList.contains("empty")) { box.textContent = ""; box.classList.remove("empty"); }
    const row = document.createElement("div");
    row.textContent = value;
    box.appendChild(row);
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, message }),
    });
    if (!res.ok || !res.body) throw new Error(`Server returned ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const handle = (ev) => {
      if (ev.type === "status") {
        status.textContent = ev.text;
        addTrace(activity.body, ev.text);
        // A status prefix adds memory transparency without changing the SSE event types.
        if (/^(using memory|memory|past messages?|notes?):/i.test(ev.text)) addTrace(context.body, ev.text);
      } else if (ev.type === "token") {
        if (!gotToken) status.textContent = "Writing answer…";
        gotToken = true;
        text += ev.text;
        bot.innerHTML = markdown(text); // re-render whole text: simple, and fast enough for chat-sized answers
      } else if (ev.type === "sources") {
        const box = el("div", "sources");
        box.setAttribute("aria-label", "Sources used");
        ev.sources.forEach((s, i) => {
          const a = document.createElement("a");
          a.href = /^https?:\/\//.test(s.url) ? s.url : "#"; // same http(s)-only rule as markdown links
          a.target = "_blank"; a.rel = "noopener noreferrer";
          a.textContent = `${i + 1}. ${s.title || s.url}`;
          a.title = s.url;
          box.appendChild(a);
        });
        list.insertBefore(box, bot.nextSibling);
      } else if (ev.type === "error") {
        throw new Error(ev.text || "Something went wrong");
      } else if (ev.type === "done") {
        finished = true;
        status.textContent = "Done";
        status.classList.add("done");
      }
      scroll();
    };

    // SSE frames are separated by a blank line. A network chunk can end mid-frame,
    // so keep the unfinished tail in buf until the rest arrives.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop();
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue; // ignore comments/keep-alives
          try { handle(JSON.parse(line.slice(5).trim())); }
          catch (e) { if (e instanceof SyntaxError) continue; throw e; } // skip bad JSON, surface real errors
        }
      }
    }
    if (!finished && !gotToken) throw new Error("The connection closed before an answer arrived");
  } catch (err) {
    status.remove();
    if (!gotToken) bot.remove(); // drop the empty bubble/typing dots; keep partial answers
    showError(err.message);
  } finally {
    if (!gotToken) bot.querySelector(".typing")?.remove();
    streaming = false; sendBtn.disabled = false;
    input.focus();
  }
}

function showError(msg) {
  const box = el("div", "error");
  box.append(`Error: ${msg} `);
  const retry = document.createElement("button");
  retry.type = "button"; retry.textContent = "Retry";
  retry.onclick = () => { box.remove(); retryLast(); };
  box.appendChild(retry);
  scroll(true);
}

// Retry resends the same text. The earlier user bubble is removed first so it isn't shown twice.
function retryLast() {
  const users = list.querySelectorAll(".msg.user");
  users[users.length - 1]?.remove();
  send(lastMessage);
}

// ---------- input handling ----------
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const m = input.value;
  if (!m.trim() || streaming) return;
  input.value = ""; autosize();
  send(m);
});
input.addEventListener("keydown", (e) => {
  // isComposing: don't send while an IME (e.g. Japanese) is confirming a character with Enter.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
});
function autosize() { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; }
input.addEventListener("input", autosize);

$("new-chat").addEventListener("click", () => {
  if (streaming) return; // avoid mixing a running answer into the new conversation
  conversationId = crypto.randomUUID();
  try { localStorage.setItem(KEY, conversationId); } catch {}
  list.innerHTML = "";
  input.focus();
});

input.focus();
