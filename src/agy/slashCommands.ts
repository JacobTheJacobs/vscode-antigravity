/**
 * Antigravity's slash-command catalog, surfaced by the in-panel navigator.
 *
 * Captured from the real `agy` TUI (35 entries) by the MIT-licensed
 * lyadhgod/antigravity-vscode project — reused with thanks. Commands like
 * /compact, /memory, /init and /cost do NOT exist in agy and are absent on
 * purpose.
 *
 * `target` is the honest part:
 *   native  — this extension implements it (works here).
 *   session — it only runs inside agy's interactive TUI. This panel drives
 *             `agy -p`, which has no TUI, so selecting one inserts the text
 *             rather than pretending it executed. /context and /usage (the
 *             token and quota views) are session-only, which is precisely why
 *             this panel cannot show a token counter.
 */

export interface SlashCommand {
    name: string;
    description: string;
    target: 'native' | 'session';
    alias?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
    // Panel-native: these map to agy flags this extension already passes, so
    // they genuinely take effect here. /mode and /attach are deliberately
    // absent — the composer has a chip and a + button for those, and a second
    // route to the same menu is clutter, not discoverability.
    { name: '/effort', description: 'Reasoning effort — slider', target: 'native' },
    { name: '/sandbox', description: 'Sandboxed terminal access — switch', target: 'native' },
    { name: '/add-dir', description: 'Show workspace folders in scope', target: 'native' },
    { name: '/agents', description: 'List custom agents (agy agents)', target: 'native' },
    { name: '/artifact', description: 'View and review artifacts', target: 'session' },
    { name: '/btw', description: 'Ask a side question without interrupting the task', target: 'session' },
    { name: '/changelog', description: 'Show release notes and changes', target: 'session' },
    { name: '/clear', description: 'Clear the conversation and start a new one', target: 'native', alias: 'new' },
    { name: '/config', description: 'Open the settings panel', target: 'session', alias: 'settings' },
    { name: '/context', description: 'Visualize context usage (TUI only)', target: 'session' },
    { name: '/copy', description: 'Copy the last response to the clipboard', target: 'native' },
    { name: '/credits', description: 'Show remaining credits and purchase link', target: 'session' },
    { name: '/diff', description: 'View uncommitted changes and per-turn diffs', target: 'session' },
    { name: '/exit', description: 'Exit the session', target: 'session', alias: 'quit' },
    { name: '/fast', description: 'Execute tasks directly — faster for simple tasks', target: 'session' },
    { name: '/feedback', description: 'Submit feedback to improve the agent', target: 'session' },
    { name: '/fork', description: 'Branch the conversation at this point', target: 'session', alias: 'branch' },
    { name: '/goal', description: 'Run until the specified goal is finished', target: 'session' },
    { name: '/grill-me', description: 'Interview me to align on a plan', target: 'session' },
    { name: '/help', description: 'Show available commands', target: 'native' },
    { name: '/hooks', description: 'Manage hook configurations for tool events', target: 'session' },
    { name: '/keybindings', description: 'Set custom keybindings', target: 'session' },
    { name: '/logout', description: 'Log out and clear saved credentials', target: 'session' },
    { name: '/mcp', description: 'MCP servers agy will connect to', target: 'native' },
    { name: '/model', description: 'Set the active model', target: 'native' },
    { name: '/open', description: 'Open a file or view opened/edited files', target: 'session' },
    { name: '/permissions', description: 'Manage tool permissions', target: 'session' },
    { name: '/planning', description: 'Plan before executing — for complex tasks', target: 'session' },
    { name: '/rename', description: 'Rename the current conversation', target: 'session' },
    { name: '/resume', description: 'Browse and resume past conversations', target: 'native', alias: 'switch' },
    { name: '/rewind', description: 'Rewind to a previous message', target: 'session', alias: 'undo' },
    { name: '/schedule', description: 'Run an instruction on a schedule', target: 'session' },
    { name: '/skills', description: 'List installed skills', target: 'native' },
    { name: '/statusline', description: 'Toggle or configure the statusline', target: 'session' },
    { name: '/tasks', description: 'View background tasks', target: 'session' },
    { name: '/title', description: 'Toggle a custom terminal window title', target: 'session' },
    { name: '/usage', description: 'View model quota usage (TUI only)', target: 'session', alias: 'quota' },
];

/** Prefix matches rank above substring matches, so the closest command wins. */
/**
 * Commands this panel can actually run, before the ones only agy's TUI
 * accepts.
 *
 * The catalog was in authored order and the caller showed the first twelve,
 * so /mcp, /skills, /model and /resume — all of which work here — sat behind
 * /artifact, /btw, /changelog and /credits, which do not. Someone looking for
 * their MCP servers found no sign the panel knew about them.
 */
function byUsefulness(list: SlashCommand[]): SlashCommand[] {
    const native = list.filter((c) => c.target === 'native');
    const rest = list.filter((c) => c.target !== 'native');
    return [...native, ...rest];
}

export function filterSlashCommands(query: string): SlashCommand[] {
    const q = query.trim().toLowerCase();
    if (q === '' || q === '/') return byUsefulness(SLASH_COMMANDS);
    const names = (c: SlashCommand) => (c.alias ? [c.name, '/' + c.alias] : [c.name]);
    const bare = q.replace(/^\//, '');
    const starts = SLASH_COMMANDS.filter((c) => names(c).some((n) => n.toLowerCase().startsWith(q)));
    const rest = SLASH_COMMANDS.filter(
        (c) => !starts.includes(c) && names(c).some((n) => n.toLowerCase().includes(bare))
    );
    return byUsefulness([...starts, ...rest]);
}
