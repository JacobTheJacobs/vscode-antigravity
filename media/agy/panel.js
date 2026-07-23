"use strict";
/* Antigravity chat webview. Streams `agy -p` output from the host into the live
 * assistant bubble. State is intentionally tiny: one in-flight turn, one live
 * bubble to append into. */

(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  // Connection state lives in the empty state, not a top bar: when it is fine
  // there is nothing to say, and when it is not the reader is already looking
  // at the middle of an empty panel.
  let connState = "connecting";   // "connecting" | "ok" | "bad"
  let connDetail = "";
  let extVersion = "";
  let extAuthor = "";

  let live = null; // the assistant .bubble currently streaming
  let liveRaw = "";   // raw markdown accumulated for the live bubble
  let renderTimer = null;
  let busy = false;
  let connected = false;
  let elapsedTimer = null;


  function doConnect() {
    // Connecting must also clear a stuck turn, or the composer stays disabled.
    stopElapsed();
    if (thinkingTurn) { thinkingTurn.remove(); thinkingTurn = null; }
    if (live) live.classList.remove("streaming");
    live = null;
    setBusy(false);
    connState = "connecting";
    if (!log.querySelector(".turn")) showEmpty();
    vscode.postMessage({ type: "connect" });
  }

  /* A prompt in a large repo can take 20s+. Static dots read as "frozen", so
     count the seconds — the same information, but it proves it's alive. */
  function startElapsed(el) {
    stopElapsed();
    const started = Date.now();
    elapsedTimer = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      const label = el.querySelector(".elapsed");
      if (label) label.textContent = s >= 1 ? ` ${s}s` : "";
    }, 1000);
  }

  function stopElapsed() {
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  showEmpty();

  function showEmpty() {
    let extra = "";
    if (connState === "connecting") {
      extra = '<div class="empty-conn">Connecting to Antigravity…</div>';
    } else if (connState === "bad") {
      // Only a failure is worth words. A working connection says nothing.
      extra =
        '<div class="empty-conn bad">' + esc(connDetail || "agy did not respond") + "</div>" +
        '<button class="empty-connect" type="button" data-act="connect">Connect</button>';
    }
    log.innerHTML =
      '<div class="empty"><b>Antigravity</b><br>' +
      "Chat with Gemini through the agy CLI. Ask anything about your code." +
      extra +
      (extVersion || extAuthor
        ? '<div class="empty-ver">' +
          (extVersion ? "v" + esc(extVersion) : "") +
          (extVersion && extAuthor ? " · " : "") +
          // The maintainer's name opens the repo. A byline you cannot follow
          // is decoration; this is the one place someone looks for "who made
          // this and where do I report a bug".
          (extAuthor
            ? '<a href="#" class="empty-repo" data-act="repo">' + esc(extAuthor) + "</a>"
            : "") +
          "</div>"
        : "") +
      "</div>";
  }

  function clearEmpty() {
    const e = log.querySelector(".empty");
    if (e) e.remove();
  }

  function addTurn(role, text) {
    clearEmpty();
    const turn = document.createElement("div");
    turn.className = "turn " + role;
    const label = document.createElement("div");
    label.className = "role";
    label.textContent = role === "user" ? "You" : role === "error" ? "Error" : "Antigravity";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (text != null) bubble.textContent = text;
    turn.appendChild(label);
    turn.appendChild(bubble);
    log.appendChild(turn);
    scroll();
    return bubble;
  }

  function thinking() {
    clearEmpty();
    const turn = document.createElement("div");
    turn.className = "turn assistant";
    turn.dataset.thinking = "1";
    turn.innerHTML =
      '<div class="role">Antigravity</div>' +
      '<div class="thinking">Thinking<span class="dots"><span></span><span></span><span></span></span>' +
      '<span class="elapsed"></span></div>';
    log.appendChild(turn);
    scroll();
    startElapsed(turn);
    return turn;
  }

  log.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="connect"]')) { doConnect(); return; }
    if (e.target.closest('[data-act="repo"]')) {
      e.preventDefault();
      vscode.postMessage({ type: "openRepo" });
      return;
    }
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const code = btn.closest(".md-code").querySelector("code");
    navigator.clipboard.writeText(code ? code.textContent : "");
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 1200);
  });

  /* 16px icons. Inline SVG rather than a codicon font: the webview has no
     stylesheet from the host, and a missing glyph renders as a blank box. */
  const ICON_COPY =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.6" fill="none" ' +
    'stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M10.8 3.2H3.9a1.6 1.6 0 0 0-1.6 1.6v6.9" fill="none" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M3.4 8.6l3 3 6.2-7.2" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_UPLOAD =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
    '<path d="M8 11V3.4M5.2 6.2L8 3.4l2.8 2.8M2.8 11.4v1.2a1.4 1.4 0 0 0 1.4 1.4h7.6' +
    'a1.4 1.4 0 0 0 1.4-1.4v-1.2" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_FOLDER =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
    '<path d="M2.2 12.4V4.2a1 1 0 0 1 1-1h2.9l1.4 1.7h4.3a1 1 0 0 1 1 1v6.5' +
    'a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const ICON_FILE =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
    '<path d="M9 2.4H4.6a1 1 0 0 0-1 1v9.2a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V5.8z" ' +
    'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M9 2.4v3.4h3.4" fill="none" stroke="currentColor" stroke-width="1.3" ' +
    'stroke-linejoin="round"/></svg>';
  const ICON_UP =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
    '<path d="M8 12.6V4.2M4.6 7.6L8 4.2l3.4 3.4" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* A copy control under a finished answer, the way Claude Code offers one. */
  function addCopyAction(bubble, raw) {
    const turn = bubble.parentElement;
    if (!turn || turn.querySelector(".turn-actions")) return;
    const bar = document.createElement("div");
    bar.className = "turn-actions";
    const btn = document.createElement("button");
    // Icon, not the word: it sits under every answer, and a labelled button
    // there reads as part of the reply instead of as chrome.
    btn.className = "turn-action icon";
    btn.type = "button";
    btn.title = "Copy message";
    btn.setAttribute("aria-label", "Copy message");
    btn.innerHTML = ICON_COPY;
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(raw);
      btn.innerHTML = ICON_CHECK;
      btn.classList.add("done");
      setTimeout(() => { btn.innerHTML = ICON_COPY; btn.classList.remove("done"); }, 1200);
    });
    bar.appendChild(btn);
    turn.appendChild(bar);
  }

  /* One row per real tool execution, from agy's stream-json step events. These
     are reported by the CLI — nothing here is inferred. */
  function toolRow(step) {
    let row = toolRows[step.index];
    if (!row) {
      clearEmpty();
      row = document.createElement("div");
      row.className = "turn tool";
      row.innerHTML =
        '<div class="role"><span class="toolname"></span>' +
        '<span class="toolmeta"></span></div>';
      log.appendChild(row);
      toolRows[step.index] = row;
    }
    row.dataset.state = String(step.state || "").toLowerCase();
    row.querySelector(".toolname").textContent = step.name;
    const meta = row.querySelector(".toolmeta");
    meta.textContent =
      step.state === "ACTIVE" ? "running…"
      : step.state === "ERROR" ? "failed"
      : (typeof step.seconds === "number" ? step.seconds.toFixed(2) + "s" : "done");
    scroll();
  }

  /* agy writes generated pictures to disk and only mentions the path, so the
     host resolves what the answer points at and sends it back here. Rendering
     it inline is the difference between "I made an image" and seeing it. */
  function showMedia(items) {
    if (!items || !items.length) return;
    const turns = log.querySelectorAll(".turn.assistant");
    const turn = turns[turns.length - 1];
    if (!turn || turn.querySelector(".media")) return;
    const box = document.createElement("div");
    box.className = "media";
    box.innerHTML = items.map((m) =>
      '<figure class="mediaitem" title="' + esc(m.path || m.name) + '">' +
      (m.kind === "video"
        ? '<video src="' + esc(m.src) + '" controls preload="metadata"></video>'
        : '<img src="' + esc(m.src) + '" alt="' + esc(m.name) + '" loading="lazy">') +
      '<figcaption>' + esc(m.name) + "</figcaption></figure>"
    ).join("");
    turn.appendChild(box);
    scroll();
  }

  function paintUsage() {
    const el = document.getElementById("usage");
    if (!el) return;
    if (!lastUsage) { el.hidden = true; return; }
    const u = lastUsage;
    const k = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
    el.hidden = false;
    // in / out / thinking, with the total as the title — the numbers agy
    // actually reports, not an estimate.
    // In/out only. The thinking count is real but it is the third number on a
    // row that also holds three chips, so it lives in the tooltip.
    el.textContent = k(u.input_tokens || 0) + " in · " + k(u.output_tokens || 0) + " out";
    el.title = "total " + (u.total_tokens || 0).toLocaleString() + " tokens" +
      (u.thinking_tokens ? " · " + u.thinking_tokens.toLocaleString() + " thinking" : "");
  }

  function scroll() {
    log.scrollTop = log.scrollHeight;
  }

  const IDLE_PLACEHOLDER = input.getAttribute("placeholder") || "Ask Antigravity…";

  function setBusy(on) {
    busy = on;
    // The button holds an SVG arrow — setting textContent would erase it. The
    // stop state is CSS only (.stop hides the arrow and draws a square).
    send.classList.toggle("stop", on);
    send.title = on ? "Stop this turn (Esc)" : "Send";
    send.setAttribute("aria-label", on ? "Stop this turn" : "Send message");
    // Say what Enter will do NOW. Mid-turn it queues rather than sends, and
    // nothing on screen was admitting that.
    input.placeholder = on
      ? "Queue a follow-up…  •  Esc to stop"
      : IDLE_PLACEHOLDER;
    input.disabled = false; // stay typeable; Enter is gated on !busy
  }

  function submit() {
    const text = input.value.trim();

    // Slash commands are panel actions, not prompts, so they are handled
    // BEFORE the busy check. With the old order, typing /model while an answer
    // was streaming hit the stop branch instead: it cancelled the turn and left
    // the command sitting in the box.
    if (/^\/[a-z-]+$/i.test(text)) {
      runSlash(text.toLowerCase());
      return;
    }

    if (!text) return;

    // Sending mid-turn used to cancel the turn, so a follow-up thought
    // destroyed the answer it was following up on. agy cannot take input
    // mid-run — "input-format" appears nowhere in its binary, and
    // --prompt-interactive needs a PTY — so the honest version is to hold the
    // message and send it the moment the turn lands. It continues the same
    // conversation, so the agent still has the context.
    if (busy) {
      queued.push(text);
      paintQueue();
      input.value = "";
      autosize();
      return;
    }

    // An open menu would sit on top of the answer it is about to produce.
    closePicker();
    const refs = pending.map((a) => "@" + a.path);
    const bubble = addTurn("user", text);
    if (pending.length) {
      // Show the thumbnails in the turn, so the transcript reflects what was
      // actually sent rather than just the words.
      const strip = document.createElement("div");
      strip.className = "turnimgs";
      strip.innerHTML = pending.map((a) =>
        a.src ? '<img src="' + esc(a.src) + '" alt="' + esc(a.name) + '">' : ""
      ).join("");
      bubble.parentElement.appendChild(strip);
    }
    const sent = refs.length ? text + " " + refs.join(" ") : text;
    pending = [];
    paintTray();
    input.value = "";
    autosize();
    // Placeholder assistant turn shows dots until the first chunk lands.
    toolRows = {};
    thinkingTurn = thinking();
    setBusy(true);
    vscode.postMessage({ type: "send", text: sent });
  }

  let thinkingTurn = null;
  /* Pending attachments: {path, src, name}. They are referenced as @path when
     the turn is sent, and their thumbnails are shown in the user's bubble so
     the transcript matches what agy actually received. */
  let pending = [];
  /* Data URLs for images pasted but not yet confirmed by the host, in paste
     order. Each 'pasted' reply claims the oldest one. */
  let pendingPreview = [];
  /* Messages typed while a turn was running, sent in order once it ends. */
  let queued = [];
  /* Tool rows keyed by agy's step_index, so an ACTIVE row is upgraded in place
     when its DONE/ERROR arrives instead of being appended twice. */
  let toolRows = {};
  let lastUsage = null;

  function paintQueue() {
    const el = document.getElementById("queue");
    if (!el) return;
    el.hidden = queued.length === 0;
    el.innerHTML = queued.map((t, i) =>
      '<div class="queueitem"><span class="qtext">' + esc(t) + "</span>" +
      '<button class="qx" type="button" data-unqueue="' + i +
      '" title="Remove">&times;</button></div>'
    ).join("");
  }

  /* Hand the queue back to the composer rather than dropping it. Whatever
     ended the turn, the words the user typed are still theirs. */
  function drainQueueToInput() {
    if (!queued.length) return;
    const rest = queued.join("\n\n");
    input.value = input.value.trim() ? input.value.trim() + "\n\n" + rest : rest;
    queued = [];
    paintQueue();
    autosize();
  }

  /* Start the next queued message, if the turn ended cleanly. */
  function sendNextQueued() {
    if (!queued.length || busy) return;
    const next = queued.shift();
    paintQueue();
    input.value = next;
    autosize();
    submit();
  }

  function paintTray() {
    const tray = document.getElementById("tray");
    if (!tray) return;
    tray.hidden = pending.length === 0;
    tray.innerHTML = pending.map((a, i) =>
      '<span class="chipimg" title="' + esc(a.path) + '">' +
      (a.src ? '<img src="' + esc(a.src) + '" alt="">' : "") +
      '<span class="chipname">' + esc(a.name) + "</span>" +
      '<button class="chipx" type="button" data-drop="' + i + '">&times;</button></span>'
    ).join("");
  }

  document.addEventListener("click", (e) => {
    const q = e.target.closest("[data-unqueue]");
    if (q) {
      queued.splice(parseInt(q.dataset.unqueue, 10), 1);
      paintQueue();
      return;
    }
    const x = e.target.closest("[data-drop]");
    if (!x) return;
    pending.splice(parseInt(x.dataset.drop, 10), 1);
    paintTray();
  });

  /* The button is the stop control mid-turn. Enter queues; only pressing the
     button itself cancels, so a queued follow-up can never abort the run by
     accident. */
  send.addEventListener("click", (e) => {
    if (!busy) return;
    e.preventDefault();
    vscode.postMessage({ type: "stop" });
  });

  /* Ctrl+V of an image: the clipboard hands over bytes, but agy takes a path,
     so the host writes the bytes to disk and returns one. */
  input.addEventListener("paste", (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let handled = false;
    for (const it of items) {
      if (it.kind !== "file" || !/^image\//.test(it.type)) continue;
      const file = it.getAsFile();
      if (!file) continue;
      handled = true;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        // Hold the data URL locally for the thumbnail. Round-tripping a
        // webview file URI back from the host was one more thing to get
        // wrong, and it rendered as a broken image; the bytes are already
        // here and `img-src data:` is already allowed by the CSP.
        pendingPreview.push(dataUrl);
        vscode.postMessage({
          type: "pasteImage",
          data: dataUrl,
          ext: (it.type.split("/")[1] || "png").replace("+xml", ""),
        });
      };
      reader.readAsDataURL(file);
    }
    // Only swallow the event for images; pasting text must still paste text.
    if (handled) e.preventDefault();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // submit() decides what Enter means — a slash command runs even while a
      // turn is streaming, so the busy check belongs in there, not here.
      submit();
    }
  });

  /* Shift+Tab cycles Auto -> Plan -> Accept edits, the way Claude Code does.
     Tab alone is left to the editor so focus traversal still works. */
  const MODE_CYCLE = ["", "plan", "accept-edits"];
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || !e.shiftKey) return;
    e.preventDefault();
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length];
    currentMode = next;
    paintMode();
    vscode.postMessage({ type: "setMode", mode: next });
  });

  // Escape closes an open menu, which every menu in VS Code and Claude Code
  // does. Without it the only way out was clicking the chip again.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = (picker && !picker.hidden) || (pickerTop && !pickerTop.hidden);
    if (open) {
      closePicker();
      input.focus();
      return;
    }
    // Esc cancels the turn, the way Claude Code and every terminal agent does.
    // Clicking a 26px circle was the only way to stop, which is why "how do I
    // stop it" was a question at all.
    if (busy) {
      e.preventDefault();
      vscode.postMessage({ type: "stop" });
    }
  });

  input.addEventListener("input", autosize);
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px";
  }

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case "toolsDenied": {
        const b = addTurn("error", msg.text || "A tool was denied.");
        const fix = document.createElement("button");
        fix.className = "chipbtn";
        fix.type = "button";
        fix.textContent = "Enable tool access";
        fix.style.marginTop = "8px";
        fix.addEventListener("click", () => {
          currentTools = true;
          vscode.postMessage({ type: "setTools", on: true });
          fix.textContent = "Enabled — ask again";
          fix.disabled = true;
        });
        b.parentElement.appendChild(fix);
        break;
      }
      case "replay": {
        // The prompts and tool calls agy kept. Its own answers are not in the
        // transcript, so the panel says so rather than implying an empty
        // conversation.
        clearEmpty();
        const head = document.createElement("div");
        head.className = "replay-head";
        head.textContent = "Earlier in this conversation";
        log.appendChild(head);
        (msg.turns || []).forEach((t) => {
          if (t.role === "user") {
            addTurn("user", t.text).parentElement.classList.add("replayed");
          } else if (t.role === "assistant") {
            const b = addTurn("assistant", null);
            b.innerHTML = window.AgyMarkdown.render(t.text);
            b.parentElement.classList.add("replayed");
          } else {
            const row = document.createElement("div");
            row.className = "turn tool replayed";
            row.dataset.state = "done";
            row.innerHTML = '<div class="role"><span class="toolname"></span></div>';
            row.querySelector(".toolname").textContent = t.text;
            log.appendChild(row);
          }
        });
        // Only say what is missing when something IS missing. A full replay
        // needs no apology.
        if (!msg.full) {
          const note = document.createElement("div");
          note.className = "replay-note";
          note.textContent =
            "This conversation was started outside the panel, so agy's transcript " +
            "gives its prompts and tool calls but not its replies. It still has " +
            "the full history; keep asking.";
          log.appendChild(note);
        }
        scroll();
        break;
      }
      case "media":
        showMedia(msg.items);
        break;
      case "tree":
        showTree(msg.dir || "", msg.entries || []);
        break;
      case "version":
        extVersion = msg.version || "";
        extAuthor = msg.author || "";
        if (!log.querySelector(".turn")) showEmpty();
        break;
      case "status":
        if (msg.connecting) {
          connState = "connecting";
        } else if (msg.connected) {
          connected = true;
          connState = "ok";
          connDetail = "";
        } else {
          connected = false;
          connState = "bad";
          connDetail = msg.detail || "agy did not respond";
        }
        // Repaint only while the panel is empty — never disturb a transcript.
        if (!log.querySelector(".turn")) showEmpty();
        break;
      case "models":
        models = msg.models || [];
        currentModel = msg.current || "";
        if (modelBtn) modelBtn.textContent = shortModel(currentModel);
        if (msg.show !== false && document.activeElement === modelBtn) { /* no-op */ }
        if (msg.open) openPicker("Model", modelRows());
        break;
      case "modes":
        currentMode = msg.mode || "";
        currentEffort = msg.effort || "";
        currentSandbox = !!msg.sandbox;
        currentTools = !!msg.tools;
        extraFolders = msg.folders || 0;
        paintMode();
        paintEffort();
        // The chip owns ONE decision: how agy executes. Effort, sandbox and
        // context each get their own slash command, so this menu is a short
        // list of mutually exclusive choices rather than a settings drawer.
        if (msg.open === "mode") {
          openPicker("Agent mode", [
            { act: "mode", value: "", name: "Auto", icon: modeIcon(""),
              meta: "agy decides when to ask — its own default", on: currentMode === "" },
            { act: "mode", value: "plan", name: "Plan", icon: modeIcon("plan"),
              meta: "explore and propose a plan, never write", on: currentMode === "plan" },
            { act: "mode", value: "accept-edits", name: "Accept edits", icon: modeIcon("accept-edits"),
              meta: "apply file edits without asking first", on: currentMode === "accept-edits" },
          ], "mode", "⇧⇥ to switch");
        } else if (msg.open === "effort" || msg.open === "sandbox") {
          // One surface. Whether you arrive from the chip or from "/", the
          // control you want is a row you adjust in place.
          openExecution();
        }
        break;
      case "files":
        if (picker) picker.dataset.kind = "files";
        openPicker("Add context", (msg.files || []).map((f) => ({
          act: "file", value: f.rel, name: f.name, meta: f.rel,
        })), "files");
        break;
      case "mcp":
        openPicker("MCP servers", (msg.servers || []).map((m) => ({
          act: "noop", value: "", name: m.name, meta: m.detail,
        })), "mcp");
        break;
      case "skills":
        openPicker("Skills", (msg.skills || []).map((s) => ({
          act: "noop", value: "", name: s.name, meta: s.description,
        })));
        break;
      case "agents":
        openPicker("Custom agents", (msg.agents || []).map((a) => ({
          act: "noop", value: "", name: a, meta: "",
        })));
        break;
      case "folders":
        openPicker("Workspace folders in scope", (msg.folders || []).map((f, i) => ({
          act: "noop", value: "",
          name: f.split(/[\\/]/).filter(Boolean).pop() || f,
          // The first is the working directory; the rest ride on --add-dir.
          meta: i === 0 ? "cwd" : "--add-dir",
        })));
        break;
      case "sessions":
        openPicker("Past conversations", (msg.sessions || []).map((s) => ({
          act: "session", value: s.id,
          // The prompt it opened with, which is what anyone scanning this list
          // is actually looking for. Twenty rows of "Today 5:42 PM / started in
          // terminal" told you nothing about which one to reopen.
          name: s.title || "Untitled conversation",
          meta: when(s.mtime),
          on: s.id === msg.current,
        })));
        break;
      case "slash":
        if (picker) picker.dataset.kind = "slash";
        openPicker("Commands", (msg.commands || []).map((c) => {
          const row = {
            act: "slash", value: c.name, name: c.name,
            meta: c.description, tui: c.target === "session",
          };
          // A setting you can see is a setting you can change here. Sending
          // these two to their own panel meant reading "— slider" and then
          // hunting for the slider.
          if (c.name === "/effort") {
            row.act = "noop"; row.control = effortSliderHtml(); row.controlKind = "effort";
            row.meta = "Reasoning effort";
          } else if (c.name === "/sandbox") {
            row.act = "noop"; row.control = toggleHtml("sandbox", currentSandbox);
            row.controlKind = "sandbox"; row.meta = "Sandboxed terminal access";
          }
          return row;
        }));
        break;
      case "pasted":
        pending.push({
          path: msg.path,
          src: pendingPreview.shift() || msg.src || "",
          name: msg.name,
        });
        paintTray();
        input.focus();
        break;
      case "pasteFailed":
        addTurn("error", "Could not attach the pasted image: " + (msg.reason || "unknown"));
        break;
      case "attached":
        // Insert references, not bytes: agy reads the files itself via @path.
        input.value = (input.value.trim() + " " + (msg.refs || []).join(" ")).trim() + " ";
        input.focus();
        autosize();
        break;
      case "resumed":
        // A new or resumed conversation is a different context; carrying a
        // queue across would deliver it to the wrong one.
        queued = [];
        paintQueue();
        toolRows = {};
        lastUsage = null;
        paintUsage();
        log.innerHTML = "";
        showEmpty();
        setBusy(false);
        break;
      case "externalPrompt":
        addTurn("user", msg.text || "");
        thinkingTurn = thinking();
        setBusy(true);
        break;
      case "tool":
        // A tool row means the thinking placeholder has served its purpose.
        if (thinkingTurn) { stopElapsed(); thinkingTurn.remove(); thinkingTurn = null; }
        toolRow(msg);
        break;
      case "usage":
        lastUsage = msg.usage;
        paintUsage();
        break;
      case "init":
        break;
      case "resultText":
        // Only used when the run produced no text_delta at all, so a normal
        // turn is never rendered twice.
        if (!liveRaw && msg.text) {
          if (thinkingTurn) { stopElapsed(); thinkingTurn.remove(); thinkingTurn = null; }
          const b = addTurn("assistant", "");
          b.innerHTML = window.AgyMarkdown.render(msg.text);
          addCopyAction(b, msg.text);
        }
        break;
      case "start":
        // First real signal; the dots are already up from submit().
        break;
      case "chunk":
        // An empty delta is not the start of an answer. Opening a bubble on one
        // tore down the thinking dots and left a blank turn sitting there while
        // agy was still working.
        if (!msg.text) break;
        if (!live) {
          stopElapsed();
          if (thinkingTurn) {
            thinkingTurn.remove();
            thinkingTurn = null;
          }
          live = addTurn("assistant", "");
          live.classList.add("streaming");
          liveRaw = "";
        }
        liveRaw += msg.text;
        // Re-rendering the whole bubble per chunk is wasteful on long answers;
        // coalesce to ~10fps. The final render happens on "done" regardless.
        if (!renderTimer) {
          renderTimer = setTimeout(() => {
            renderTimer = null;
            if (live) { live.innerHTML = window.AgyMarkdown.render(liveRaw); scroll(); }
          }, 90);
        }
        scroll();
        break;
      case "error":
        stopElapsed();
        if (thinkingTurn) {
          thinkingTurn.remove();
          thinkingTurn = null;
        }
        if (live) live.classList.remove("streaming");
        live = null;
        // The host does follow every error with a 'done' today, but the panel
        // should not depend on that ordering: an error arriving alone left the
        // composer stuck in its stop state, with Enter still queueing.
        setBusy(false);
        // Do NOT chain the queue onto a failed run: "agy exited with code 1"
        // would then repeat once per queued message. Hand them back instead.
        drainQueueToInput();
        {
          const b = addTurn("error", msg.text || "Something went wrong.");
          if (msg.needsPermission) {
            const fix = document.createElement("button");
            fix.className = "chipbtn";
            fix.type = "button";
            fix.textContent = "Open agy settings";
            fix.style.marginTop = "6px";
            fix.addEventListener("click", () => vscode.postMessage({ type: "openPermissions" }));
            b.parentElement.appendChild(fix);
          }
        }
        break;
      case "done":
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        if (live && liveRaw) {
          live.innerHTML = window.AgyMarkdown.render(liveRaw);
          // Copy the raw markdown, not the rendered text: pasting an answer
          // elsewhere should keep its code fences and lists.
          addCopyAction(live, liveRaw);
        }
        liveRaw = "";
        stopElapsed();
        // Stop posts 'done' as well, so an explicit cancel would otherwise
        // fire off the queue the user just interrupted. Drain only a turn that
        // ended on its own; a stop hands the words back.
        if (msg.stopped) {
          drainQueueToInput();
        } else {
          setTimeout(sendNextQueued, 0);
        }
        if (thinkingTurn) {
          thinkingTurn.remove();
          thinkingTurn = null;
        }
        if (live) live.classList.remove("streaming");
        live = null;
        setBusy(false);
        break;
    }
  });

  /* ---------- picker: models, history, slash commands ---------- */

  const picker = document.getElementById("picker");
  const pickerTop = document.getElementById("pickerTop");
  const modelBtn = document.getElementById("modelBtn");
  const historyBtn = document.getElementById("historyBtn");
  const newBtn = document.getElementById("newBtn");

  /* Click anywhere else and the menu goes away, which is what every menu in
     VS Code does. Escape worked and clicking the chip again worked, but a
     click on the transcript left it hanging over the answer.

     Bound in the CAPTURE phase so it runs before the pickers' own handlers.
     In the bubble phase a row click would close the menu and then be
     re-examined against a picker that had already been emptied. */
  document.addEventListener("click", (e) => {
    const closed = (picker || {}).hidden !== false && (pickerTop || {}).hidden !== false;
    if (closed) return;
    // Inside a menu: it handles its own clicks.
    if (e.target.closest(".picker")) return;
    // On the control that opened it: that button toggles, and closing here
    // first would make it reopen immediately.
    if (e.target.closest(
      "#plusBtn, #slashBtn, #modelBtn, #modeBtn, #effortBtn, #historyBtn, #newBtn"
    )) { return; }
    closePicker();
  }, true);
  let models = [];
  let currentModel = "";
  const modeBtn = document.getElementById("modeBtn");
  let currentMode = "";
  let currentEffort = "";
  let currentSandbox = false;
  let currentTools = false;
  let extraFolders = 0;

  const MODE_LABEL = { "": "Auto", "plan": "Plan", "accept-edits": "Accept edits" };

  /* A glyph per mode, the way Claude Code marks its modes. Each says what the
     mode does: a bolt for "just go", a document for "plan first", brackets for
     "write the code". Inline SVG so no icon font has to load. */
  const MODE_ICON = {
    "": '<path d="M9 2 4 9h3.2L7 14l5-7H8.8L9 2z" fill="currentColor"/>',
    "plan":
      '<path d="M4.2 2.6h7.6v10.8H4.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M6 5.6h4M6 8h4M6 10.4h2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    "accept-edits":
      '<path d="M6 5.4 3.4 8 6 10.6M10 5.4 12.6 8 10 10.6" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  function modeIcon(value) {
    return '<svg viewBox="0 0 16 16" class="pickico" aria-hidden="true">' +
      (MODE_ICON[value] || "") + "</svg>";
  }

  /* "model" as a label read like a placeholder bug. Empty means the CLI's own
     default, so say that; otherwise trim the vendor prefix that makes every
     name look identical in a narrow chip. */
  function shortModel(m) {
    if (!m) return "Default";
    return m.replace(/^gemini-/, "").replace(/^claude-/, "");
  }

  function paintMode() {
    if (!modeBtn) return;
    const t = document.getElementById("modeText");
    if (t) t.textContent = MODE_LABEL[currentMode] || "Auto";
    modeBtn.classList.toggle("on", currentMode === "plan");
  }

  /* Reasoning effort was invisible until you went hunting through the command
     list, and the /effort row promised a slider you could not see. A chip makes
     the current value readable at a glance and opens the slider in one click,
     the same contract the model and mode chips already have. */
  function paintEffort() {
    const btn = document.getElementById("effortBtn");
    if (!btn) return;
    const t = document.getElementById("effortText");
    if (t) t.textContent = EFFORT_LABEL[currentEffort] || "Default";
    // The gauge fills to the level, so the setting reads without the word.
    btn.dataset.level = String(Math.max(0, EFFORT_STEPS.indexOf(currentEffort)));
  }

  function closePicker() {
    for (const el of [picker, pickerTop]) {
      if (el) { el.hidden = true; el.innerHTML = ""; }
    }
  }

  /* History and New sit in the top bar, so their menu drops from the top; the
     composer controls open upward from the composer. A menu that appears at
     the far end of the panel from the button you pressed reads as unrelated. */
  function anchorFor(kind) {
    return kind === "past" ? (pickerTop || picker) : picker;
  }

  function openPicker(title, rows, kind, hint) {
    const k = kind || title.toLowerCase().split(" ")[0];
    const target = anchorFor(k);
    if (!target) return;
    closePicker();               // only one menu open at a time
    const picker = target;       // shadow: the rest of this function is generic
    picker.dataset.kind = k;
    if (!rows.length) {
      picker.innerHTML =
        '<div class="picker-head">' + esc(title) + "</div>" +
        '<div class="picker-head" style="text-transform:none">Nothing to show.</div>';
      picker.hidden = false;
      return;
    }
    picker.innerHTML =
      '<div class="picker-head">' + esc(title) +
      (hint ? '<span class="picker-hint">' + esc(hint) + "</span>" : "") + "</div>" +
      rows.map(function (r) {
        return (
          '<button class="pick' + (r.on ? " on" : "") + '" type="button" data-act="' +
          esc(r.act) + '" data-value="' + esc(r.value) + '">' +
          // r.icon is our own SVG constant, never model or file data, so it is
          // the one field inserted without escaping.
          (r.icon || "") +
          '<span class="name">' + esc(r.name) + "</span>" +
          '<span class="meta">' + esc(r.meta || "") + "</span>" +
          (r.tui ? '<span class="tui">TUI only</span>' : "") +
          // r.control is our own markup too, and it sits at the right edge so
          // the row reads "what it is ... what it is set to".
          (r.control
            ? '<span class="rowcontrol" data-control="' + esc(r.controlKind || "") + '">' +
              r.control + "</span>"
            : "") +
          "</button>"
        );
      }).join("");
    picker.hidden = false;
  }

  /* Some choices are a position on a scale or an on/off, not a list. Rendering
     those as menu rows made the user read four lines to move one notch. */
  function openCustom(title, inner, kind, hint) {
    const target = anchorFor(kind);
    if (!target) return;
    closePicker();
    target.dataset.kind = kind;
    target.innerHTML =
      '<div class="picker-head">' + esc(title) +
      (hint ? '<span class="picker-hint">' + esc(hint) + "</span>" : "") + "</div>" +
      '<div class="picker-custom">' + inner + "</div>";
    target.hidden = false;
  }

  const EFFORT_STEPS = ["", "low", "medium", "high"];
  const EFFORT_LABEL = { "": "Default", low: "Low", medium: "Medium", high: "High" };

  /* Spans, not buttons. These render INSIDE a .pick row, and a button nested
     in a button is invalid HTML the parser unnests — which would silently lift
     the control out of the row it belongs to. */
  /* A real track with a knob you drag, not four buttons in a row. Stops are
     small marks on the track; the knob is the thing you aim at and the thing
     that tells you where you are. */
  function effortSliderHtml() {
    const i = Math.max(0, EFFORT_STEPS.indexOf(currentEffort));
    const last = EFFORT_STEPS.length - 1;
    const pct = (n) => (n / last) * 100 + "%";
    return (
      '<span class="slider" data-slider="effort" role="slider" tabindex="0" ' +
      'aria-label="Reasoning effort" aria-valuemin="0" aria-valuemax="' + last +
      '" aria-valuenow="' + i + '" aria-valuetext="' + esc(EFFORT_LABEL[EFFORT_STEPS[i]]) +
      '" style="--pos:' + pct(i) + '">' +
      '<span class="slider-track"></span>' +
      EFFORT_STEPS.map((v, n) =>
        '<span class="slider-dot" style="left:' + pct(n) + '" ' +
        'data-effort="' + v + '" title="' + esc(EFFORT_LABEL[v]) + '"></span>'
      ).join("") +
      '<span class="slider-knob"></span>' +
      "</span>"
    );
  }

  /* Move the knob without touching the host. A drag crosses several stops and
     each one would otherwise be a round trip; the value is committed on
     release instead. */
  function paintSlider(el, idx) {
    const last = EFFORT_STEPS.length - 1;
    el.style.setProperty("--pos", (idx / last) * 100 + "%");
    el.setAttribute("aria-valuenow", String(idx));
    el.setAttribute("aria-valuetext", EFFORT_LABEL[EFFORT_STEPS[idx]]);
    // The row names the value, the way Claude's menu does.
    const row = el.closest(".pick");
    const meta = row && row.querySelector(".meta");
    if (meta && row.querySelector('[data-control="effort"]')) {
      meta.textContent = EFFORT_LABEL[EFFORT_STEPS[idx]];
    }
  }

  function sliderIndex(el, clientX) {
    const r = el.getBoundingClientRect();
    const last = EFFORT_STEPS.length - 1;
    const t = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
    return Math.round(t * last);
  }

  function commitEffort(idx) {
    currentEffort = EFFORT_STEPS[idx];
    vscode.postMessage({ type: "setEffort", effort: currentEffort });
    paintEffort();
  }

  document.addEventListener("pointerdown", (e) => {
    const sl = e.target.closest('[data-slider="effort"]');
    if (!sl) return;
    // Stop the row underneath from treating this as a click on itself.
    e.preventDefault();
    sl.classList.add("dragging");
    let idx = sliderIndex(sl, e.clientX);
    paintSlider(sl, idx);
    const move = (ev) => { idx = sliderIndex(sl, ev.clientX); paintSlider(sl, idx); };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      sl.classList.remove("dragging");
      commitEffort(idx);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });

  /* Arrow keys, because a slider that only responds to a mouse is not one. */
  document.addEventListener("keydown", (e) => {
    const sl = e.target.closest && e.target.closest('[data-slider="effort"]');
    if (!sl) return;
    const last = EFFORT_STEPS.length - 1;
    let idx = parseInt(sl.getAttribute("aria-valuenow"), 10) || 0;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { idx = Math.min(last, idx + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { idx = Math.max(0, idx - 1); }
    else if (e.key === "Home") { idx = 0; }
    else if (e.key === "End") { idx = last; }
    else { return; }
    e.preventDefault();
    e.stopPropagation();      // Esc-to-stop lives on the same element chain
    paintSlider(sl, idx);
    commitEffort(idx);
  });

  function toggleHtml(name, on) {
    return (
      '<span class="switch' + (on ? " on" : "") + '" role="switch" ' +
      'data-toggle="' + esc(name) + '" aria-checked="' + (on ? "true" : "false") +
      '"><span class="knob"></span></span>'
    );
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* No stored title means the conversation began outside this panel. Show when
     it happened rather than a hex id nobody can recognise. */
  /* Say only what distinguishes this row from its neighbours. Repeating
     "Today" down a list where everything is from today is noise; a date that
     omits the year is a lie once the list spans one. */
  function when(ms) {
    const d = new Date(ms), now = new Date();
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((today - day) / 86400000);
    if (days === 0) return t;
    if (days === 1) return "Yesterday " + t;
    if (days < 7) return d.toLocaleDateString([], { weekday: "short" }) + " " + t;
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
    }
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  }

  function ago(ms) {
    const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  const effortBtn = document.getElementById("effortBtn");
  if (effortBtn) effortBtn.addEventListener("click", () => {
    if (picker && !picker.hidden && picker.dataset.kind === "effort") return closePicker();
    // Same round trip the /effort command makes, rather than opening from a
    // local copy that could be stale.
    vscode.postMessage({ type: "listModes", open: "effort" });
  });

  if (modeBtn) modeBtn.addEventListener("click", () => {
    if (picker && !picker.hidden && picker.dataset.kind === "mode") return closePicker();
    vscode.postMessage({ type: "listModes", open: "mode" });
  });

  function openModelPicker() {
    // `agy models` spawns a process (~1s). Painting only on its reply made the
    // chip feel dead, so open immediately from cache and let the reply refresh
    // it. First run shows an explicit loading row rather than nothing.
    openPicker("Model", models.length
      ? modelRows()
      : [{ act: "noop", value: "", name: "Loading models…", meta: "agy models" }]);
    vscode.postMessage({ type: "listModels", open: true });
  }

  /* Describe a model from its own slug — vendor, family, and the trailing
     reasoning-effort variant agy documents. Parsing what the name already
     says avoids inventing capability claims about models we cannot measure. */
  function describeModel(id) {
    const m = /^(.*?)-(high|medium|low|thinking)$/.exec(id);
    const base = m ? m[1] : id;
    const tier = m ? m[2] : "";
    let vendor = "";
    if (/^gemini-/.test(base)) vendor = "Gemini";
    else if (/^claude-/.test(base)) vendor = "Claude";
    else if (/^gpt-/.test(base)) vendor = "GPT";
    const rest = base.replace(/^(gemini|claude|gpt)-/, "").replace(/-/g, " ");
    const tierText =
      tier === "thinking" ? "extended thinking"
      : tier ? tier + " reasoning effort" : "";
    return [vendor && vendor + " " + rest, tierText].filter(Boolean).join(" · ");
  }

  function modelRows() {
    if (!models.length) {
      return [{ act: "noop", value: "", name: "No models available",
                meta: "agy not found or `agy models` returned nothing" }];
    }
    return models
      .map((m) => ({ act: "model", value: m, name: m, meta: describeModel(m), on: m === currentModel }))
      .concat([{ act: "model", value: "", name: "Default", meta: "agy's own default", on: !currentModel }]);
  }

  if (modelBtn) modelBtn.addEventListener("click", () => {
    if (picker && !picker.hidden && picker.dataset.kind === "model") return closePicker();
    openModelPicker();
  });
  if (historyBtn) historyBtn.addEventListener("click", () => {
    if (pickerTop && !pickerTop.hidden) return closePicker();
    vscode.postMessage({ type: "listSessions" });
  });
  /* Render one directory as a picker. Folders descend, files insert @rel —
     the same reference form agy already accepts from @-mentions. */
  function showTree(dir, entries) {
    const rows = [];
    if (dir) {
      rows.push({
        act: "browse",
        value: dir.split("/").slice(0, -1).join("/"),
        name: "..",
        meta: "up",
        icon: ICON_UP,
      });
    }
    entries.forEach((e) => {
      rows.push({
        act: e.dir ? "browse" : "file",
        value: e.rel,
        name: e.name,
        meta: e.dir ? "" : "attach",
        icon: e.dir ? ICON_FOLDER : ICON_FILE,
      });
    });
    openPicker(dir ? "/" + dir : "Workspace", rows, "tree",
      // Say when a folder is empty. With only the ".." row it looked identical
      // to a folder still loading, or to one whose contents had been filtered.
      entries.length ? (dir ? "" : "folders and files") : "empty");
  }

  const plusBtn = document.getElementById("plusBtn");
  if (plusBtn) plusBtn.addEventListener("click", () => {
    closePicker();
    // Two different intents used to share one button: attaching something from
    // disk, and pulling in a file that is already in the workspace. The dialog
    // only served the first.
    openPicker("Add context", [
      { act: "upload", value: "", name: "Upload a file…", meta: "from disk", icon: ICON_UPLOAD },
      { act: "browse", value: "", name: "Browse workspace", meta: "files and folders", icon: ICON_FOLDER },
    ], "plus");
  });

  /* Effort and sandbox as rows with their controls on them, the way a settings
     menu shows a slider next to the thing it sets. */
  function openExecution() {
    openPicker("Execution", [
      { act: "noop", value: "", name: "Effort", meta: "faster ↔ deeper",
        control: effortSliderHtml(), controlKind: "effort" },
      { act: "noop", value: "", name: "Sandbox", meta: "restrict terminal access",
        control: toggleHtml("sandbox", currentSandbox), controlKind: "sandbox" },
      { act: "noop", value: "", name: "Tool access",
        meta: "let agy read files and run commands without asking",
        control: toggleHtml("tools", currentTools), controlKind: "tools" },
    ], "effort");
  }

  const slashBtn = document.getElementById("slashBtn");
  if (slashBtn) slashBtn.addEventListener("click", () => {
    if (picker && !picker.hidden) return closePicker();
    vscode.postMessage({ type: "listSlash", query: "/" });
  });

  if (newBtn) newBtn.addEventListener("click", () => {
    closePicker();
    vscode.postMessage({ type: "newSession" });
  });

  /* Repaint one control in place instead of rebuilding the menu. Reopening
     scrolled a twenty-row command list back to the top on every notch, which
     made stepping through the slider unusable. */
  function repaint(el, kind) {
    const holder = el.closest(".rowcontrol, .picker-custom");
    if (!holder) return;
    holder.innerHTML =
      kind === "effort" ? effortSliderHtml()
      : kind === "tools" ? toggleHtml("tools", currentTools)
      : toggleHtml("sandbox", currentSandbox);
  }

  const onCustom = (e) => {
    // Effort is handled by the pointer/keyboard slider handlers above. Leaving
    // a click branch here too made every drag commit the value twice.
    if (e.target.closest('[data-slider="effort"]')) return true;
    const sw = e.target.closest("[data-toggle]");
    if (sw) {
      const which = sw.dataset.toggle;
      if (which === "tools") {
        currentTools = !currentTools;
        vscode.postMessage({ type: "setTools", on: currentTools });
      } else {
        currentSandbox = !currentSandbox;
        vscode.postMessage({ type: "setSandbox", on: currentSandbox });
      }
      repaint(sw, which);
      return true;
    }
    return false;
  };

  const onPick = (e) => {
    if (onCustom(e)) return;
    const btn = e.target.closest(".pick");
    if (!btn) return;
    const act = btn.dataset.act, value = btn.dataset.value;
    // A settings row is not a destination. Closing the menu on a stray click
    // near its slider threw away the menu the user was still adjusting.
    if (act === "noop") return;
    closePicker();
    if (act === "model") {
      currentModel = value;
      if (modelBtn) modelBtn.textContent = shortModel(value);
      vscode.postMessage({ type: "setModel", model: value, models: models });
    } else if (act === "mode") {
      vscode.postMessage({ type: "setMode", mode: value });
    } else if (act === "sandbox") {
      vscode.postMessage({ type: "setSandbox", on: !!value });
    } else if (act === "effort") {
      vscode.postMessage({ type: "setEffort", effort: value });
    } else if (act === "session") {
      vscode.postMessage({ type: "resumeSession", id: value });
    } else if (act === "file") {
      // Replace the partial @token with the resolved path agy accepts. Coming
      // from the + browser there is no token to replace, so append instead —
      // otherwise picking a file from the tree silently did nothing.
      if (/(^|\s)@[^\s@]*$/.test(input.value)) {
        input.value = input.value.replace(/(^|\s)@([^\s@]*)$/, "$1@" + value + " ");
      } else {
        input.value = (input.value.trim() + " @" + value + " ").replace(/^\s+/, "");
      }
      input.focus();
      autosize();
    } else if (act === "upload") {
      vscode.postMessage({ type: "attach" });
    } else if (act === "browse") {
      vscode.postMessage({ type: "browse", path: value });
    } else if (act === "slash") {
      runSlash(value);
    }
  };
  if (picker) picker.addEventListener("click", onPick);
  if (pickerTop) pickerTop.addEventListener("click", onPick);

  /* Native commands do the thing; TUI-only ones are inserted as text, because
     firing them into print mode would look like they ran when they did not. */
  function runSlash(name) {
    input.value = "";
    autosize();
    switch (name) {
      case "/model":
        openModelPicker();
        return;
      case "/clear":
      case "/new":
        vscode.postMessage({ type: "newSession" });
        return;
      case "/resume":
      case "/switch":
        vscode.postMessage({ type: "listSessions" });
        return;
      case "/copy": {
        const bubbles = log.querySelectorAll(".turn.assistant .bubble");
        const last = bubbles[bubbles.length - 1];
        if (last) navigator.clipboard.writeText(last.textContent || "");
        return;
      }
      case "/help":
        vscode.postMessage({ type: "listSlash", query: "/" });
        return;
      case "/mode":
        vscode.postMessage({ type: "listModes", open: "mode" });
        return;
      case "/effort":
        vscode.postMessage({ type: "listModes", open: "effort" });
        return;
      case "/sandbox":
        vscode.postMessage({ type: "listModes", open: "sandbox" });
        return;
      case "/attach":
        vscode.postMessage({ type: "attach" });
        return;
      case "/mcp":
        vscode.postMessage({ type: "listMcp" });
        return;
      case "/skills":
        vscode.postMessage({ type: "listSkills" });
        return;
      case "/agents":
        vscode.postMessage({ type: "listAgents" });
        return;
      case "/add-dir":
        vscode.postMessage({ type: "listFolders" });
        return;
      default:
        input.value = name + " ";
        input.focus();
        autosize();
    }
  }

  /* @-mention navigator: agy resolves @path itself, so typing @ offers the
     workspace files and inserts the reference it already understands. */
  input.addEventListener("input", () => {
    const v = input.value;
    const at = /(^|\s)@([^\s@]*)$/.exec(v);
    if (at) {
      vscode.postMessage({ type: "findFiles", query: at[2] });
    } else if (picker && !picker.hidden && picker.dataset.kind === "files") {
      closePicker();
    }
  });

  /* Slash navigator: typing "/" at the start of an empty-ish prompt filters. */
  input.addEventListener("input", () => {
    const v = input.value;
    if (v.startsWith("/") && !v.includes("\n")) {
      vscode.postMessage({ type: "listSlash", query: v });
    } else if (picker && !picker.hidden && picker.dataset.kind === "slash") {
      closePicker();
    }
  });

  /* Dictation. The button stays hidden unless the runtime actually provides
     speech recognition — an always-visible mic that does nothing would be
     decoration pretending to be a feature. */
  (function setupMic() {
    const micBtn = document.getElementById("micBtn");
    if (!micBtn) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    micBtn.hidden = false;
    let rec = null;

    micBtn.addEventListener("click", () => {
      if (rec) { rec.stop(); return; }
      try {
        rec = new SR();
      } catch (_) {
        micBtn.hidden = true;
        return;
      }
      rec.continuous = true;
      rec.interimResults = false;
      const base = input.value;
      rec.onresult = (e) => {
        let said = "";
        for (let i = e.resultIndex; i < e.results.length; i++) said += e.results[i][0].transcript;
        input.value = (base + " " + said).trim();
        autosize();
      };
      const stop = () => { rec = null; micBtn.classList.remove("rec"); };
      rec.onend = stop;
      rec.onerror = stop;
      micBtn.classList.add("rec");
      rec.start();
    });
  })();

  input.focus();
  // Probe the CLI as soon as the panel exists, so the status bar shows a real
  // state instead of sitting on "Connecting…" until the first prompt.
  vscode.postMessage({ type: "ready" });
  vscode.postMessage({ type: "listModels" });
  vscode.postMessage({ type: "listModes" });
})();
