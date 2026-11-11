// MiniMe chat UI. Vanilla ES module, no dependencies.
// Flow: send() -> POST /api/chat -> read SSE stream -> update the DOM per event.

const $ = (id) => document.getElementById(id);
const list = $("messages"), input = $("input"), sendBtn = $("send");
const welcomeMarkup = $("welcome").outerHTML;

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

// ---------- mobile conversation drawer ----------
const sidebarToggle = $("sidebar-toggle");
function setSidebar(open) {
  document.body.classList.toggle("sidebar-open", open);
  sidebarToggle.setAttribute("aria-expanded", String(open));
}
sidebarToggle.addEventListener("click", () => setSidebar(!document.body.classList.contains("sidebar-open")));
$("sidebar-close").addEventListener("click", () => setSidebar(false));
$("sidebar-scrim").addEventListener("click", () => setSidebar(false));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") setSidebar(false); });

// ---------- inspectable response preferences ----------
// Local persistence makes the UI useful before Claude wires the profile into the agent prompt.
const PROFILE_KEY = "minime.userProfile.v1";
const profileDefaults = {
  answerLength: "balanced", tone: "direct", structure: "mixed",
  leadWithRecommendation: true, compareInTables: true, adaptiveLearning: false,
};
const profileForm = $("preference-form");
const profilePanel = $("personalize-panel");
function loadProfile() {
  try { return { ...profileDefaults, ...JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}") }; }
  catch { return { ...profileDefaults }; }
}
function renderProfile(profile) {
  for (const [key, value] of Object.entries(profile)) {
    const control = profileForm.elements.namedItem(key);
    if (control instanceof RadioNodeList) control.value = String(value);
    else if (control instanceof HTMLInputElement) control.checked = Boolean(value);
  }
  $("preference-status").textContent = `${profile.answerLength} · ${profile.tone} · ${profile.structure}`;
}
function setProfilePanel(open) {
  document.body.classList.toggle("personalize-open", open);
  profilePanel.setAttribute("aria-hidden", String(!open));
  if (open) { renderProfile(loadProfile()); $("personalize-close").focus(); }
  else $("personalize-open").focus();
}
$("personalize-open").addEventListener("click", () => setProfilePanel(true));
$("personalize-close").addEventListener("click", () => setProfilePanel(false));
$("personalize-scrim").addEventListener("click", () => setProfilePanel(false));
profileForm.addEventListener("change", () => {
  const data = new FormData(profileForm);
  const profile = {
    answerLength: data.get("answerLength"), tone: data.get("tone"), structure: data.get("structure"),
    leadWithRecommendation: data.has("leadWithRecommendation"), compareInTables: data.has("compareInTables"),
    adaptiveLearning: data.has("adaptiveLearning"), updatedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch {}
  renderProfile(profile);
});
$("preferences-reset").addEventListener("click", () => {
  try { localStorage.removeItem(PROFILE_KEY); } catch {}
  renderProfile(profileDefaults);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("personalize-open")) setProfilePanel(false);
});
renderProfile(loadProfile());

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
  let para = [], items = [], listType = "";
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => {
    if (items.length) out.push(`<${listType}>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</${listType}>`);
    items = []; listType = "";
  };
  const startList = (type, value) => {
    flushPara();
    if (listType && listType !== type) flushList();
    listType = type; items.push(value);
  };
  for (const line of text.split("\n")) {
    const heading = line.match(/^(#{2,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) { flushPara(); flushList(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
    else if (bullet) startList("ul", bullet[1]);
    else if (numbered) startList("ol", numbered[1]);
    else if (quote) { flushPara(); flushList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); }
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

function detailBox(label) {
  const details = document.createElement("details");
  details.className = "trace";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const body = document.createElement("div");
  body.className = "trace-body";
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
  $("welcome")?.remove();

  el("div", "msg user", message);
  const bot = el("div", "msg bot");
  bot.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; // typing indicator
  const provenance = detailBox("Sources & context");
  provenance.details.hidden = true;
  let status = el("div", "status", "Connecting…"), text = "", gotToken = false, finished = false;
  let hasPreview = false;
  list.insertBefore(status, bot);
  scroll(true);

  let memoryNotes = [], memoryDescription = "", sourceList = [];
  const renderProvenance = () => {
    provenance.body.replaceChildren();
    const parts = [];
    if (sourceList.length) parts.push(`${sourceList.length} web source${sourceList.length === 1 ? "" : "s"}`);
    if (memoryNotes.length) parts.push(`${memoryNotes.length} memory note${memoryNotes.length === 1 ? "" : "s"}`);
    else if (memoryDescription) parts.push("past conversation");
    provenance.details.hidden = !parts.length;
    provenance.details.querySelector("summary").textContent = `Sources & context · ${parts.join(" · ")}`;

    if (memoryNotes.length || memoryDescription) {
      const heading = document.createElement("h3");
      heading.textContent = "Memory used";
      provenance.body.appendChild(heading);
    }
    const group = document.createElement("div");
    group.className = "memory-cards";
    for (const note of memoryNotes) {
      const card = document.createElement("article");
      card.className = "memory-card";
      const header = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = note.topic;
      const meta = document.createElement("span");
      const date = new Date(note.createdAt);
      const stability = note.volatility === "volatile" ? "May change" : "Stable";
      meta.textContent = `${Number.isNaN(date.valueOf()) ? note.createdAt : date.toLocaleDateString([], { month: "short", day: "numeric" })} · ${stability}`;
      const claim = document.createElement("p");
      claim.textContent = note.claim;
      header.append(title, meta);
      card.append(header, claim);
      group.appendChild(card);
    }
    if (memoryNotes.length) provenance.body.appendChild(group);
    else if (memoryDescription) {
      const fallback = document.createElement("p");
      fallback.className = "memory-fallback";
      fallback.textContent = memoryDescription;
      provenance.body.appendChild(fallback);
    }

    if (sourceList.length) {
      const heading = document.createElement("h3");
      heading.textContent = "Web sources";
      const links = document.createElement("div");
      links.className = "provenance-links";
      sourceList.forEach((source, index) => {
        const a = document.createElement("a");
        a.href = /^https?:\/\//.test(source.url) ? source.url : "#";
        a.target = "_blank"; a.rel = "noopener noreferrer";
        let domain = source.url;
        try { domain = new URL(source.url).hostname.replace(/^www\./, ""); } catch {}
        const title = document.createElement("strong");
        title.textContent = `${index + 1}. ${source.title || domain}`;
        const meta = document.createElement("span");
        const date = source.publishedAt ? new Date(source.publishedAt) : null;
        const dateText = date && !Number.isNaN(date.valueOf())
          ? ` · ${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}` : "";
        meta.textContent = `${domain}${dateText} ↗`;
        a.append(title, meta);
        links.appendChild(a);
      });
      provenance.body.append(heading, links);
    }
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
      } else if (ev.type === "preview") {
        hasPreview = true;
        bot.classList.add("preview");
        bot.innerHTML = `<span class="preview-label">Quick take</span>${markdown(ev.text)}`;
        status.textContent = "Preparing the detailed answer…";
      } else if (ev.type === "memory") {
        memoryDescription = ev.text || "Past conversation context";
        memoryNotes = Array.isArray(ev.notes) ? ev.notes : [];
        renderProvenance();
      } else if (ev.type === "token") {
        if (!gotToken) {
          status.textContent = "Writing answer…";
          if (hasPreview) { bot.classList.remove("preview"); text = ""; }
        }
        gotToken = true;
        text += ev.text;
        bot.innerHTML = markdown(text); // re-render whole text: simple, and fast enough for chat-sized answers
      } else if (ev.type === "sources") {
        sourceList = Array.isArray(ev.sources) ? ev.sources : [];
        renderProvenance();
      } else if (ev.type === "error") {
        throw new Error(ev.text || "Something went wrong");
      } else if (ev.type === "done") {
        finished = true;
        status.remove();
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
    if (!gotToken) { bot.remove(); provenance.details.remove(); } // drop empty response furniture
    showError(err.message);
  } finally {
    if (!gotToken) bot.querySelector(".typing")?.remove();
    streaming = false; sendBtn.disabled = false;
    input.focus();
    loadHistory(); // the finished exchange is now in memory: refresh the sidebar
  }
}

// ---------- sidebar: all chats ----------
// Titles/times come from the server's message log. textContent only: titles are user text.
async function loadHistory() {
  const ul = $("history");
  try {
    const res = await fetch("/api/conversations");
    if (!res.ok) throw new Error(String(res.status));
    const chats = await res.json();
    $("history-count").textContent = chats.length ? String(chats.length) : "";
    ul.replaceChildren();
    if (!chats.length) {
      const li = document.createElement("li");
      li.className = "history-empty"; li.textContent = "No chats yet";
      ul.appendChild(li);
      return;
    }
    for (const c of chats) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button"; b.className = "history-item";
      b.setAttribute("aria-current", String(c.id === conversationId));
      b.textContent = c.title || "New chat";
      const when = document.createElement("small");
      when.textContent = `${new Date(c.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${c.messages} messages`;
      b.appendChild(when);
      b.addEventListener("click", () => openChat(c.id));
      // Separate button (not nested in the row button, which is invalid HTML).
      const del = document.createElement("button");
      del.type = "button"; del.className = "history-delete"; del.textContent = "×";
      del.setAttribute("aria-label", `Delete chat: ${c.title || "New chat"}`);
      del.addEventListener("click", () => deleteChat(c));
      li.className = "history-row";
      li.append(b, del);
      ul.appendChild(li);
    }
  } catch { /* sidebar is a convenience: leave it as is if the server can't list chats */ }
}

// Deletes one stored chat after confirming. If it is the one on screen, reset to a new chat.
async function deleteChat(c) {
  if (streaming) return;
  if (!confirm(`Delete "${c.title || "this chat"}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(c.id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) { alert(`Could not delete: ${err.message}`); return; }
  if (c.id === conversationId) $("new-chat").click(); // also refreshes the sidebar
  else loadHistory();
}

// Reload a past conversation into the view and make it the active one, so new messages
// continue it. Sources/trace aren't stored in memory, so only the text comes back.
async function openChat(id, force = false) {
  if (streaming || (id === conversationId && !force)) return;
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const msgs = await res.json();
    if (!msgs.length) return; // nothing stored yet (e.g. a brand-new chat): keep the welcome screen
    conversationId = id;
    setSidebar(false);
    try { localStorage.setItem(KEY, id); } catch {}
    list.replaceChildren();
    for (const m of msgs) {
      const node = el("div", `msg ${m.role === "user" ? "user" : "bot"}`);
      if (m.role === "user") node.textContent = m.content; else node.innerHTML = markdown(m.content);
    }
    scroll(true);
    loadHistory();
  } catch (err) { showError(`Could not open that chat: ${err.message}`); }
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
  list.innerHTML = welcomeMarkup;
  setSidebar(false);
  bindSuggestions();
  input.focus();
  loadHistory();
});

// Clear only the conversation on screen. Other chats and their memory remain untouched.
$("clear-chat").addEventListener("click", async () => {
  if (streaming) return;
  const hasMessages = Boolean(list.querySelector(".msg"));
  if (!hasMessages) return; // a brand-new chat has nothing persisted to delete
  if (!confirm("Delete this conversation and its saved memory? Your other chats will stay.")) return;
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    alert(`Could not clear this chat: ${err.message}`);
    return; // keep the current chat on screen if the server did not clear
  }
  $("new-chat").click();
});

function bindSuggestions() {
  list.querySelectorAll(".suggestions button").forEach((button) => {
    button.addEventListener("click", () => send(button.dataset.prompt || button.textContent));
  });
}

bindSuggestions();
input.focus();
loadHistory();
openChat(conversationId, true); // after a page reload, show the chat the user was in
