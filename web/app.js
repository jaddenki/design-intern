const SECTIONS = [
  ["shipped", "Shipped"],
  ["in_review", "In review"],
  ["in_progress", "In progress"],
  ["decisions", "Decisions & discussion"],
  ["risks", "Blocked & risks"],
  ["next", "Up next"],
];
const KIND_LABEL = { linear: "Linear", github: "GitHub", slack: "Slack", figma: "Figma", doc: "Doc", note: "Check-in" };

const $ = (id) => document.getElementById(id);
const state = { drafts: [], current: null, chat: [], busy: false };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "content-type": "application/json" } : {},
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function streamApi(path, body, onEvent) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtTime = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const stripEmoji = (s) => s.replace(/:[a-z_]+:\s*/g, "");

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* A fenced block with a Copy button. SVG previews render through <img>, which never runs scripts. */
function codeBlock(lang, code) {
  const isSvg = lang === "svg" || /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(code);
  const onDark = isSvg && /fill="(#fff(fff)?|white)"/i.test(code);
  const preview = isSvg
    ? `<div class="code-preview${onDark ? " on-dark" : ""}"><img alt="SVG preview" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}"></div>`
    : "";
  return `<div class="code">${preview}<div class="code-bar"><span>${escapeHtml(lang || (isSvg ? "svg" : "code"))}</span><button class="copy" type="button">Copy</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

/* Slack mrkdwn → safe HTML. Escape first, then add a small allowlisted set of tags. */
function mrkdwn(src) {
  return src
    .split(/```([a-z]*)\n?([\s\S]*?)```/)
    .map((part, i, parts) => {
      if (i % 3 === 1) return "";
      if (i % 3 === 2) return codeBlock(parts[i - 1], part.replace(/\n$/, ""));
      return prose(part);
    })
    .join("");
}

function prose(src) {
  const esc = escapeHtml(src);
  const inline = (s) =>
    s
      .replace(/&lt;(https?:\/\/[^|\s]+?)\|(.+?)&gt;/g, (_, u, l) => `<a href="${u.replace(/"/g, "%22")}" target="_blank" rel="noopener">${l}</a>`)
      .replace(/&lt;(https?:\/\/[^\s]+?)&gt;/g, (_, u) => `<a href="${u.replace(/"/g, "%22")}" target="_blank" rel="noopener">${u}</a>`)
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<strong>$2</strong>")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const out = [];
  let list = null;
  for (const raw of esc.split("\n")) {
    const m = raw.match(/^\s*(?:•|-|\*)\s+(.*)$/);
    if (m) {
      list ??= [];
      list.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if (list) {
      out.push(`<ul>${list.join("")}</ul>`);
      list = null;
    }
    if (raw.trim()) out.push(`<p>${inline(raw)}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}

/* Rail */
function renderRail() {
  const list = $("draft-list");
  list.replaceChildren(
    ...state.drafts.map((d) =>
      h(
        "li",
        {},
        h(
          "button",
          { class: "draft-item", "aria-current": state.current?.id === d.id ? "true" : "false", onclick: () => openDraft(d.id) },
          h("span", {}, h("div", { class: "draft-item-title" }, `${fmtDay(d.window.since)} – ${fmtDay(d.window.until)}`), h("div", { class: "draft-item-meta" }, `${d.lineCount} items`)),
          h("span", { class: `status status-${d.status}` }, d.status),
        ),
      ),
    ),
  );
  if (state.drafts.length === 0) list.append(h("li", { class: "empty-list" }, "None yet"));
}

/* Draft */
function sourceChip(ref, line) {
  return h("button", { class: `chip k-${ref.kind}`, title: ref.title, onclick: () => toggleTrace(line) }, chipLabel(ref));
}

function chipLabel(ref) {
  if (ref.kind === "linear") return ref.id.slice(7);
  if (ref.kind === "github") return `#${ref.id.split("#").pop()}`;
  if (ref.kind === "slack") return ref.title.split(":")[0];
  if (ref.kind === "figma") return "Figma";
  if (ref.kind === "note") return "Check-in";
  return ref.title;
}

function toggleTrace(lineEl) {
  lineEl.classList.toggle("is-open");
}

async function patchLine(lineId, edit) {
  try {
    state.current = await api(`/api/drafts/${state.current.id}`, { method: "PATCH", body: JSON.stringify({ edits: [{ id: lineId, ...edit }] }) });
    renderDraft();
  } catch (err) {
    toast(err.message);
    renderDraft();
  }
}

function renderLine(line, draft, editable) {
  const refs = line.sourceIds.map((id) => draft.sources[id] ?? { id, kind: "doc", title: id });
  const text = h("p", { class: "line-text", contenteditable: editable ? "true" : false, spellcheck: "true", "aria-label": "Line text" }, line.text);
  if (editable) {
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        text.blur();
      }
      if (e.key === "Escape") {
        text.textContent = line.text;
        text.blur();
      }
    });
    text.addEventListener("blur", () => {
      const next = text.textContent.trim();
      if (next !== line.text) patchLine(line.id, { text: next });
    });
  }
  const el = h("li", { class: "line" });
  const select = editable
    ? h(
        "select",
        { class: "section-select", "aria-label": "Move to section", onchange: (e) => patchLine(line.id, { section: e.target.value }) },
        SECTIONS.map(([k, label]) => h("option", { value: k, selected: k === line.section }, label)),
      )
    : null;
  el.append(
    h(
      "div",
      { class: "line-row" },
      text,
      line.editedBy ? h("span", { class: "edited", title: `Edited by ${line.editedBy}` }, "edited") : null,
      editable
        ? h(
            "div",
            { class: "line-tools" },
            select,
            h("button", { class: "icon-btn", title: "Remove line", "aria-label": "Remove line", onclick: () => patchLine(line.id, { remove: true }) }, "✕"),
          )
        : null,
    ),
    h("div", { class: "chips" }, refs.map((r) => sourceChip(r, el))),
    h(
      "div",
      { class: "trace" },
      h(
        "div",
        { class: "trace-inner" },
        h(
          "ol",
          {},
          refs.map((r) =>
            h("li", {}, h("span", { class: "trace-kind" }, KIND_LABEL[r.kind] ?? r.kind), r.url ? h("a", { href: r.url, target: "_blank", rel: "noopener" }, r.title) : h("span", {}, r.title)),
          ),
        ),
      ),
    ),
  );
  return el;
}

function renderDraft() {
  const d = state.current;
  $("checkin").hidden = true;
  $("empty").hidden = Boolean(d);
  $("draft").hidden = !d;
  $("context-toggle").hidden = !d;
  renderRail();
  if (!d) return;
  $("context-label").textContent = `About ${fmtDay(d.window.since)}–${fmtDay(d.window.until)} draft`;
  const editable = d.status === "pending";
  const posted = d.posted ? (d.posted.dryRun ? ". Approved as a dry run, nothing posted" : `. Posted to ${d.posted.channel}`) : "";

  const sections = SECTIONS.map(([key, label]) => {
    const lines = d.lines.filter((l) => l.section === key);
    if (lines.length === 0) return null;
    return h("section", { class: "section" }, h("h2", { class: "label" }, label), h("ol", { class: "lines" }, lines.map((l) => renderLine(l, d, editable))));
  });

  $("draft").replaceChildren(
    h(
      "header",
      { class: "draft-head" },
      h(
        "div",
        {},
        h("span", { class: `status status-${d.status}` }, d.status),
        h("h1", { class: "draft-title" }, `Design update · ${fmtDay(d.window.since)} – ${fmtDay(d.window.until)}`),
        h("div", { class: "draft-meta" }, `Drafted ${fmtTime(d.createdAt)} by ${d.createdBy}${posted}`),
      ),
      editable
        ? h(
            "div",
            { class: "draft-actions" },
            h("button", { class: "btn btn-danger", onclick: (e) => reject(e.currentTarget) }, "Reject"),
            h("button", { class: "btn btn-primary", onclick: (e) => approve(e.currentTarget) }, "Approve & post"),
          )
        : null,
    ),
    h(
      "div",
      { class: "draft-body" },
      d.notes.length
        ? h("aside", { class: "notes" }, h("div", { class: "label" }, "For you to check"), h("ul", {}, d.notes.map((n) => h("li", {}, n))))
        : null,
      ...sections,
      h(
        "details",
        { class: "history" },
        h("summary", { class: "label" }, `History · ${d.history.length}`),
        h("ol", {}, d.history.map((e) => h("li", {}, h("time", {}, fmtTime(e.at)), ` ${e.action} by ${e.by}${e.detail ? `: ${e.detail}` : ""}`))),
      ),
    ),
  );
}

async function openDraft(id) {
  try {
    state.current = await api(`/api/drafts/${id}`);
    history.replaceState(null, "", `#${id}`);
    $("progress").hidden = true;
    renderDraft();
  } catch (err) {
    toast(err.message);
  }
}

async function approve(btn) {
  const d = state.current;
  if (!confirmAction(btn)) return;
  try {
    state.current = await api(`/api/drafts/${d.id}/approve`, { method: "POST", body: "{}" });
    toast(state.current.posted?.dryRun ? "Approved. Dry run: nothing was posted." : "Approved and posted to Slack.");
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

async function reject(btn) {
  if (!confirmAction(btn)) return;
  try {
    state.current = await api(`/api/drafts/${state.current.id}/reject`, { method: "POST", body: "{}" });
    toast("Draft rejected.");
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

/* Two-step confirm on the button itself; no browser dialogs. */
let armed = null;
function confirmAction(btn) {
  if (armed === btn) {
    armed = null;
    return true;
  }
  armed = btn;
  const original = btn.textContent;
  btn.textContent = "Click again to confirm";
  setTimeout(() => {
    if (armed === btn) armed = null;
    btn.textContent = original;
  }, 2500);
  return false;
}

function openCheckIn() {
  if (state.busy) return;
  $("empty").hidden = true;
  $("draft").hidden = true;
  $("progress").hidden = true;
  $("checkin").hidden = false;
  $("checkin-text").focus();
}

function closeCheckIn() {
  $("checkin").hidden = true;
  renderDraft();
}

async function generate() {
  if (state.busy) return;
  const checkIn = $("checkin-text").value.trim();
  $("checkin").hidden = true;
  state.busy = true;
  $("generate").disabled = true;
  $("empty").hidden = true;
  $("draft").hidden = true;
  $("progress").hidden = false;
  const steps = $("progress-steps");
  steps.replaceChildren(h("li", {}, "Starting…"));
  try {
    await streamApi("/api/drafts/generate", { checkIn }, async (ev) => {
      if (ev.type === "progress") {
        const text = stripEmoji(ev.text);
        if (steps.lastElementChild?.textContent !== text) steps.append(h("li", {}, text));
      }
      if (ev.type === "error") throw new Error(ev.text);
      if (ev.type === "result") {
        $("checkin-text").value = "";
        await refresh();
        await openDraft(ev.draftId);
        addMessage("agent", ev.text);
      }
    });
  } catch (err) {
    steps.append(h("li", { class: "msg-error" }, err.message));
    toast(err.message);
  } finally {
    state.busy = false;
    $("generate").disabled = false;
  }
}

/* Chat */
function addMessage(role, text, extraClass = "") {
  $("suggestions").hidden = true;
  const el = h("div", { class: `msg msg-${role} ${extraClass}` });
  if (role === "agent") el.innerHTML = mrkdwn(text);
  else el.textContent = text;
  $("chat-log").append(el);
  el.scrollIntoView({ block: "end", behavior: "smooth" });
  if (role !== "progress") state.chat.push({ role, text });
  return el;
}

async function send(message) {
  if (!message.trim() || state.busy) return;
  state.busy = true;
  $("chat-send").disabled = true;
  const history = state.chat.slice(-20);
  addMessage("user", message);
  const progress = h("div", { class: "msg msg-progress" }, "Thinking…");
  $("chat-log").append(progress);
  const draftId = state.current && $("context-on").checked ? state.current.id : undefined;
  try {
    await streamApi("/api/chat", { message, draftId, history }, async (ev) => {
      if (ev.type === "progress") progress.textContent = stripEmoji(ev.text);
      if (ev.type === "error") throw new Error(ev.text);
      if (ev.type === "result") {
        progress.remove();
        addMessage("agent", ev.text);
        if (ev.draftChanged && draftId) {
          await openDraft(draftId);
          toast("Draft revised.");
        }
      }
    });
  } catch (err) {
    progress.remove();
    addMessage("agent", err.message, "msg-error");
  } finally {
    state.busy = false;
    $("chat-send").disabled = false;
  }
}

async function refresh() {
  const s = await api("/api/state");
  state.drafts = s.drafts;
  $("agent-name").textContent = s.agentName;
  document.title = `${s.agentName} Inbox`;
  $("whoami").textContent = `Signed in as ${s.user}`;
  renderRail();
  return s;
}

$("generate").addEventListener("click", openCheckIn);
$("chat-log").addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.closest(".code").querySelector("code").textContent);
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  } catch {
    toast("Couldn't copy; select the code instead.");
  }
});
$("checkin-go").addEventListener("click", generate);
$("checkin-cancel").addEventListener("click", closeCheckIn);
$("checkin-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
  if (e.key === "Escape") closeCheckIn();
});
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const msg = input.value;
  input.value = "";
  input.style.height = "";
  send(msg);
});
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("chat-input").addEventListener("input", (e) => {
  e.target.style.height = "";
  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
});
$("suggestions").addEventListener("click", (e) => {
  const q = e.target.closest("[data-q]")?.dataset.q;
  if (q) send(q);
});

const s = await refresh();
const initial = location.hash.slice(1) || s.drafts.find((d) => d.status === "pending")?.id;
if (initial) await openDraft(initial);
