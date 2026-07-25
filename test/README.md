# Panel suites

These run the **real** `media/agy/panel.js`, `panel.css` and `markdown.js` in a
browser with a stubbed host, so what they exercise is the code that ships. They
are excluded from the VSIX.

## Running

Serve or open a suite and read `#result`:

```
<browser> file:///<repo>/test/edge.suite.html
```

Each file prints `N passed, M failed` at the end. `controls.suite.html` and
`queue.suite.html` need `window.__run()` called first — their queue checks are
async, because the drain is deferred until after the turn's handler clears
`busy`.

Copy `panel.js`, `panel.css` and `markdown.js` next to the suite (as `panel.js`,
`ag.css`, `markdown.js`) before running; the suites load them by those names.

| Suite | Covers |
|---|---|
| `edge.suite.html` | 93 — escaping/XSS, markdown, tool rows, token counts, queue, slash, slider bounds, history, context, lifecycle |
| `edge2.suite.html` | 46 — streaming, copy, composer keys, menu precedence, execution state, unicode, storms, empty state |
| `panel.suite.html` | 32 — tools, skills, MCP, `@` mentions, `+` browser, attachments, dismissal |
| `controls.suite.html` | inline slider and switches on menu rows |
| `queue.suite.html` | queueing, stop, Esc, placeholder |

## What they are for

The escaping block in `edge.suite.html` is the one to keep. `panel.js` builds a
lot of `innerHTML`, and every model- or file-controlled string that reaches it —
answers, tool names, session titles, skill names, MCP servers, file paths, tree
entries, queued text, attachment names, media names, slash descriptions, errors,
model ids, the version byline, connection details — has a check that fires a
payload at it. A row that forgets `esc()` fails here instead of shipping.

## A note on expectations

Several of these failed on their first run because *the test* was wrong, not the
panel: the composer sends `pan` rather than `@pan` because the host strips the
`@` itself; the message is `folders`, not `dirs`; rows show basenames rather than
full paths; a missing tool name renders blank rather than the string
`undefined`; and `navigator.clipboard` is an accessor, so assigning to it is
silently dropped.

Each was corrected to match what the code does. A suite that encodes its
author's assumptions rather than the system's behaviour is worse than no suite,
because it makes working code look broken and invites someone to "fix" it.
