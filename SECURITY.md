# Security Policy

## Supported Versions

Only the latest release on `main` receives security fixes.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories:

https://github.com/JacobTheJacobs/vscode-antigravity/security/advisories/new

If advisories are unavailable, open a minimal issue asking for a private contact
path. Do not post exploit details, tokens, private prompts, workspace contents,
or screenshots that expose secrets in a public issue.

## Security Model

This extension is a local VS Code wrapper around the `agy` CLI.

- The extension does not make model API calls itself.
- Prompts are passed to `agy` as process arguments, not through a shell.
- Tool access is enabled by default because headless `agy` cannot answer
  permission prompts from a webview. Users can turn it off in the Execution menu.
- File and image attachments are passed as paths for `agy` to read.

When reporting a vulnerability, include the extension version, VS Code version,
operating system, and a minimal reproduction.

