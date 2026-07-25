"use strict";
/* Minimal markdown renderer for agy's replies.
 *
 * agy natively answers in markdown — fenced code blocks, **bold**, `code`,
 * bullet lists — and rendering it as preformatted text was the single biggest
 * visual gap against Claude Code. This turns it into real elements.
 *
 * Safety: every character is HTML-escaped FIRST, then formatting is applied to
 * the escaped text. Nothing the model emits can become live markup, so a reply
 * containing <script> renders as visible text rather than executing.
 *
 * Streaming: the last fence may be unterminated mid-answer, so an odd number of
 * fences is treated as "code block still open" and closed for rendering. That
 * keeps a partially-streamed block looking like code instead of leaking its
 * backticks into prose.
 */
(function (global) {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** Inline spans, applied to already-escaped text. */
  function inline(t) {
    return t
      // `code` first: its contents must not get bold/italic treatment.
      .replace(/`([^`\n]+)`/g, function (_, c) { return "<code>" + c + "</code>"; })
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      // Links render as text + visible target; we never emit a clickable href
      // from model output.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 <span class="md-url">$2</span>');
  }

  function codeBlock(lang, body) {
    const label = lang ? '<span class="md-lang">' + esc(lang) + "</span>" : "";
    return (
      '<div class="md-code">' +
      '<div class="md-code-head">' + label +
      '<button class="md-copy" type="button" data-copy>Copy</button></div>' +
      "<pre><code>" + body + "</code></pre></div>"
    );
  }

  /** Render block-level markdown from already-escaped, fence-free text. */
  function blocks(text) {
    const lines = text.split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let para = [];

    function flushPara() {
      if (para.length) {
        out.push("<p>" + inline(para.join("\n")) + "</p>");
        para = [];
      }
    }
    function flushList() {
      if (list) { out.push("</" + list + ">"); list = null; }
    }

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);

      if (h) {
        flushPara(); flushList();
        const lvl = Math.min(h[1].length + 2, 6);
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
      } else if (ul || ol) {
        flushPara();
        const want = ul ? "ul" : "ol";
        if (list !== want) { flushList(); out.push("<" + want + ">"); list = want; }
        out.push("<li>" + inline((ul || ol)[1]) + "</li>");
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara(); flushList();
    return out.join("");
  }

  /** markdown -> safe HTML. */
  function render(src) {
    const escaped = esc(src == null ? "" : src);
    const parts = escaped.split(/```/);
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        html += blocks(parts[i]);
      } else {
        // Inside a fence: first line may name the language.
        const nl = parts[i].indexOf("\n");
        const lang = nl === -1 ? parts[i].trim() : parts[i].slice(0, nl).trim();
        const body = nl === -1 ? "" : parts[i].slice(nl + 1);
        html += codeBlock(/^[\w+-]{1,20}$/.test(lang) ? lang : "", body.replace(/\n$/, ""));
      }
    }
    return html;
  }

  global.AgyMarkdown = { render: render, escape: esc };
})(typeof window !== "undefined" ? window : globalThis);
