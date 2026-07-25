# Contributing

Thanks for helping improve Antigravity CLI Copilot.

## Local Setup

1. Install Node.js 20 or newer.
2. Install dependencies:

```sh
npm ci
```

3. Compile the extension:

```sh
npm run compile
```

4. Run lint:

```sh
npm run lint
```

5. Press `F5` in VS Code to launch the extension development host.

## Manual QA

Before opening a pull request, check the main flows:

- Open the Antigravity panel.
- Send a prompt and confirm streaming output appears.
- Use `/model`, `/effort`, `/mcp`, `/skills`, and History.
- Select code in an editor and confirm the composer shows the selected-lines chip.
- Attach the selected code with `Ctrl+Esc` or by clicking the chip.
- Use `+` to browse the workspace and insert an `@file` reference.
- Paste an image and confirm a thumbnail appears before sending.

## Code Style

- Keep host-side VS Code API work in `src/agy/AgyChatViewProvider.ts`.
- Keep webview behavior in `media/agy/panel.js`.
- Keep webview styling in `media/agy/panel.css`.
- Prefer small, direct changes over broad rewrites.
- Do not add network calls to the extension; agy owns model/API communication.
- Do not pass user text through a shell. Prompts must remain argv values.

## Pull Requests

Include:

- What changed.
- How you tested it.
- Screenshots or GIFs for UI changes.
- Any known limitations.

## Packaging

Build a VSIX with:

```sh
npx @vscode/vsce package
```

