# Antigravity CLI Copilot

**Antigravity, in a real VS Code side panel.** Streaming replies, live tool
calls, generated images inline. No terminal window, no browser tab.

![The Antigravity side panel in VS Code switching from the default model to gemini-3.6-pro, then asking the LLM to read package.json and summarize the extension with a live view_file tool row and streamed answer](images/demo.gif)

## Why you'll keep it open

**Images and video appear in the chat.** Ask for one and it renders where you
asked — not as a file path you have to go open.

**Type while it's working.** Your follow-up is queued and sent the moment the
turn lands. It never cancels the answer you're waiting on. **Esc** stops.

**Real tool rows, real token counts.** Each row is a step the CLI reported,
with its actual duration. Nothing is estimated.

**Your MCP servers and skills, already loaded.** It reads agy's own config, so
whatever works in the terminal works here.

**Switch models without leaving chat.** Open `/model`, pick the model agy
reports, and the next prompt uses it.

**Selected code shows up in the composer.** Select lines in VS Code, then click
the bottom chip or press **Ctrl+Esc** to attach them to your prompt.

**`@` a file, paste a screenshot, browse the workspace from `+`.** Context
without leaving the box.

**One `/` for everything else** — model, effort, sandbox, history, agents.

## Install

1. Install this extension.
2. Have the Antigravity CLI. Check it with `agy -p "hello"`.
3. Open the **Antigravity** panel in the secondary side bar and type.

That's it. No API key, no config file, no sign-in flow — `agy` already holds
your Google AI Pro session.

> Google's older standalone CLI can't sign in with a personal account any more;
> it returns `UNSUPPORTED_CLIENT` and points you at Antigravity. This drives the
> CLI that still works.

## What it looks like

| | |
|---|---|
| ![A follow-up queued while a tool call is still running](images/queue.png) | **Queue a follow-up** mid-turn. **Enter** queues, **Esc** stops. |
| ![Slash command catalog](images/commands.png) | **`/` for everything.** Effort and sandbox adjust on the row itself. |
| ![Workspace browser](images/workspace.png) | **Browse the workspace** from `+`, or `@` a file by name. |

## Modes

**Auto** — agy decides when to ask · **Plan** — explore, never write ·
**Accept edits** — apply without asking. **Shift+Tab** cycles them.

## Under the hood

Each turn spawns one `agy` process and streams its NDJSON straight into the
panel. Sessions live in agy's own store, so conversations you started in the
terminal show up in **History** with the prompt they opened with.

The CLI is launched by absolute path with `shell: false` — nothing in a prompt
or filename ever reaches a shell.

There is no mid-turn steering, because agy cannot accept input while it works:
`input-format` appears nowhere in its binary and `--prompt-interactive` needs a
PTY. A follow-up waits for the turn instead of interrupting it.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `antigravity.command` | `agy` | Full path to the CLI, if it isn't auto-detected from `~/AppData/Local/agy/bin` or `PATH`. |
| `antigravity.printTimeout` | `30m` | How long one turn may run before agy gives up. agy's own default is 5m, which agentic turns (browser tests, builds) often exceed. A Go duration; `0` uses agy's default. |

**Tool access** is on by default, so agy can read files and run commands in
your workspace without asking each time. `agy` starts print mode in
`request-review` and a panel cannot answer a permission prompt, so with it off
every file read fails. Turn it off on the `/effort` menu; the choice is
remembered.

## Notes

Maintained by [JacobTheJacobs](https://github.com/JacobTheJacobs) ·
[source](https://github.com/JacobTheJacobs/vscode-antigravity) ·
[report a bug](https://github.com/JacobTheJacobs/vscode-antigravity/issues) · MIT

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
[Support](SUPPORT.md) · [Notices](NOTICE.md)

Unofficial. Not affiliated with Google, Microsoft or GitHub. "Antigravity" is
Google's mark and "Copilot" is Microsoft's; this project only launches a CLI you
already have installed. Prompts and code go to Google's hosted API via `agy` —
this extension makes no network calls of its own.

Slash-command catalog adapted from
[lyadhgod/antigravity-vscode](https://github.com/lyadhgod/antigravity-vscode) (MIT).
