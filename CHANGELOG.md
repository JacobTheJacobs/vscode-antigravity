# Changelog

## 3.3.4

- Attribution across the listing: `author`, README byline, issues link.
- Marketplace banner in the icon's own palette.

## 3.3.2

- **Effort is a real slider.** One track, one knob, dragging. Snaps to the
  nearest stop while you drag and commits on release, so a full-width drag is
  one change rather than three. Arrow keys, Home and End work.

## 3.3.1

- **Esc stops a running turn.** It still closes an open menu first.
- The composer says what Enter will do: mid-turn it reads
  *"Queue a follow-up… • Esc to stop"*.

## 3.3.0

- **Messages typed mid-turn are queued, not sent instead of the turn.**
  Sending used to cancel the run, so a follow-up destroyed the answer it was
  following up on. Queued messages go out in order once the turn lands, in the
  same conversation. A stop or an error hands them back to the composer rather
  than dropping them.
- Fixed the stop button: the arrow's `<svg>` stayed in the flex flow, which
  pushed the stop square off-centre.
- New mascot icon, and a flat mark for the view tab.

## 3.2.9

- **Past conversations are named by the prompt they opened with**, read from
  agy's own transcript — including conversations started in the terminal.
  Every row used to read "started in terminal".
- Timestamps scope themselves: bare time today, "Yesterday", weekday within a
  week, month and day this year, year beyond that.

## 3.2.8

- Controls draw their contrast from the foreground rather than from theme
  border tokens. The slider track measured 1.34:1 against the menu on VS Code's
  stock dark theme — invisible, not dim.

## 3.2.7

- The effort slider and the sandbox switch live on their menu rows and adjust
  in place, instead of sending you to a separate panel.
- History and New are icons.

## 3.2.4

- **Generated images and video render in the conversation.** agy writes the
  file and does not always name it, so the panel follows any path in the reply
  *and* watches the artifact directory for files written during the turn.

## 3.2.3

- `+` offers "Upload a file" or "Browse workspace".
- Copy under an answer is an icon.

## 3.2.0

- Reasoning-effort slider, sandbox switch, `@` file mentions, MCP server list,
  custom skills, image paste with a thumbnail.

## 3.1.0

- **Tool rows, streaming prose and real token counts**, via agy's undocumented
  `--output-format stream-json`. Every tool row is a step the CLI reported.
- Fixed: stdin is closed on every spawn. agy was waiting on it, which made
  `agy models` hang for 25s instead of answering in 3s.

## 3.0.0

- Rebuilt around the Antigravity CLI (`agy`). The plain `gemini` CLI can no
  longer sign in with a personal Google account.
