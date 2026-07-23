import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { filterSlashCommands } from './slashCommands';

const IS_WIN = process.platform === 'win32';

/**
 * A docked chat panel for the Antigravity CLI (`agy`), styled after the Grok
 * sidebar rather than a terminal pane.
 *
 * `agy` speaks no protocol — only `agy -p "<prompt>"`, which prints the answer
 * to stdout token-by-token (verified: an eight-line reply arrived over ~1s, not
 * in one dump). So each turn spawns one process and streams its stdout into the
 * assistant bubble. There is no session state on the CLI side; --continue would
 * be the hook if we ever want history, but a fresh process per turn keeps the
 * failure surface tiny.
 */
/** Where agy keeps one SQLite database per conversation; the file's UUID name
 *  is exactly the id `--conversation` accepts. */
function conversationsDir(): string {
    const home = (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || homedir();
    return path.join(home, '.gemini', 'antigravity-cli', 'conversations');
}

/** Where agy writes conversation artifacts: generated images, and the .md
 *  wrappers that reference them. */
function brainDir(): string {
    const home = (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || homedir();
    return path.join(home, '.gemini', 'antigravity-cli', 'brain');
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

export class AgyChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'antigravity.chat';

    private view?: vscode.WebviewView;
    private current?: ChildProcess;
    /** Conversation to resume. Empty means "start fresh on the next turn". */
    private conversationId = '';
    /** Once a turn has run in this session, later turns continue it with -c. */
    private started = false;
    /**
     * Bumped by every session reset (New, /clear, resume).
     *
     * captureTitle() runs when the process closes, which can be AFTER the user
     * has already started a new conversation — killing the child makes it close
     * immediately. Without this, clicking New mid-turn let the dying run write
     * its conversation id back and silently resurrect the chat the user just
     * cleared.
     */
    private epoch = 0;
    /** Disambiguates images pasted within the same millisecond. */
    private pasteSeq = 0;
    /** When the current turn started, so freshMedia() can tell what it wrote
     *  apart from every picture generated earlier. */
    private runStartedAt = 0;
    /** Set when any tool in this turn came back ERROR. */
    private toolDenied = false;
    /**
     * This turn's two sides, held until the conversation has an id.
     *
     * A fresh conversation does not have one until the process closes and
     * captureTitle spots the new .db, which is AFTER the result arrives — so
     * saving on the spot would file both turns under an empty key and lose
     * them.
     */
    private pendingTurns: { role: string; text: string }[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {}

    private get model(): string {
        return this.context.globalState.get<string>('antigravity.model', '');
    }

    /** '' = Auto (agy's own default), else 'plan' | 'accept-edits'. */
    private get mode(): string {
        return this.context.globalState.get<string>('antigravity.mode', '');
    }

    /** '' = the CLI default, else 'low' | 'medium' | 'high'. */
    private get effort(): string {
        return this.context.globalState.get<string>('antigravity.effort', '');
    }

    private get sandbox(): boolean {
        return this.context.globalState.get<boolean>('antigravity.sandbox', false);
    }

    /**
     * Whether agy may run its tools without asking.
     *
     * Print mode starts in permission_mode "request-review", and there is no
     * way to answer a review from a webview — so list_dir, view_file and
     * run_command all come back ERROR. Measured: the same prompt gives
     * list_dir:ERROR by default and list_dir:DONE with
     * --dangerously-skip-permissions, which flips the mode to always-proceed.
     *
     * The flag auto-approves writes and shell commands as well as reads, which
     * is why the panel says so on first use rather than leaving it to be
     * discovered. --mode accept-edits does NOT do this; it was checked and
     * leaves permission_mode untouched.
     */
    private get tools(): boolean {
        // Default ON. Off, the panel cannot read a file or run a command —
        // which is most of what anyone opens it for — and the only recovery was
        // to fail a turn, read an explanation, click a button and ask again.
        // A tool-less agent is not a safer product, it is a broken one.
        //
        // Turning it OFF is remembered as a real choice: nothing here ever
        // flips it back.
        return this.context.globalState.get<boolean>('antigravity.tools', true);
    }

    /** Has the user ever made this choice themselves? */
    private get toolsChosen(): boolean {
        return this.context.globalState.get<boolean>('antigravity.toolsChosen', false);
    }

    /**
     * Reset to a specific conversation ('' = fresh).
     *
     * Clears pendingTurns, which is the bug this centralises away: a turn
     * buffered while a fresh conversation had no id would otherwise be flushed
     * into whatever conversation the user switched to next, cross-contaminating
     * the saved transcript.
     */
    private resetTo(id: string): void {
        this.kill();
        this.epoch++;
        this.conversationId = id;
        this.started = false;
        this.pendingTurns = [];
        this.post({ type: 'resumed', id });
    }

    /** Start a fresh conversation (command palette + /clear). */
    public newSession(): void {
        this.resetTo('');
    }

    /** Send a prompt from outside the panel (Ask About Selection). */
    public async ask(text: string): Promise<void> {
        if (this.view) {
            this.view.show?.(true);
        } else {
            await vscode.commands.executeCommand('antigravity.chat.focus');
        }
        // The webview echoes the user turn, so the transcript matches what ran.
        this.post({ type: 'externalPrompt', text });
        this.run(text);
    }

    /** `agy models` — the real list, not a hardcoded one. */
    private listModels(open = false): void {
        const cli = this.resolveAgy();
        // Must always answer. The picker opens on "Loading models…" and waits
        // for this reply; returning silently left it spinning forever. That
        // became reachable the moment resolveAgy stopped falling back to the
        // bare name "agy", so the security fix created this path.
        if (!cli) {
            this.post({ type: 'models', models: [], current: this.model, open });
            return;
        }
        let child: ChildProcess;
        try {
            child = spawn(cli, ['models'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        } catch {
            this.post({ type: 'models', models: [], current: this.model, open });
            return;
        }
        let out = '';
        child.stdout?.on('data', (b) => { out += b.toString('utf8'); });
        child.on('error', () => this.post({ type: 'models', models: [], current: this.model, open }));
        child.on('close', () => {
            const models = out
                .split(/\r?\n/)
                .map((l) => l.trim())
                // Drop blanks and any header line ("Available models:"); a model
                // id never contains a space, so that alone separates them.
                .filter((l) => l && !/\s/.test(l));
            this.post({ type: 'models', models, current: this.model, open });
        });
    }

    /**
     * A conversation's own first user request, used as its name.
     *
     * Every row in History read "started in terminal" because titles only
     * existed for conversations this panel had started. agy writes the real
     * prompt into its transcript, wrapped in <USER_REQUEST>, so the name is
     * recoverable for conversations we never saw: 41 of 45 on this machine,
     * and the remaining 4 have no transcript at all.
     *
     * Scraping the SQLite store was tried first and rejected — every
     * conversation returned the same system-prompt sentence.
     */
    private conversationTitle(id: string): string {
        const file = path.join(brainDir(), id, '.system_generated', 'logs', 'transcript.jsonl');
        let head = '';
        try {
            // The first record is the user's opening turn, so read a bounded
            // head rather than a transcript that can run to megabytes.
            const fd = fs.openSync(file, 'r');
            try {
                const buf = Buffer.alloc(64 * 1024);
                const n = fs.readSync(fd, buf, 0, buf.length, 0);
                head = buf.toString('utf8', 0, n);
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return '';
        }
        // Parse the record, do NOT regex the raw file. content is a JSON string,
        // so its newlines and tabs are the two-character escapes \n and \t —
        // regexing the bytes put those in the title literally, and a prompt
        // pasted from a table came out as "\nrepo\tbranch\tfiles\tstack\n...".
        let content = '';
        for (const line of head.split(/\r?\n/)) {
            const t = line.trim();
            if (!t.startsWith('{')) { continue; }
            let rec: { type?: string; content?: unknown };
            try { rec = JSON.parse(t); } catch { continue; }   // last line may be cut
            if (rec.type === 'USER_INPUT' && typeof rec.content === 'string') {
                content = rec.content;
                break;
            }
        }
        if (!content) { return ''; }

        const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
        if (!m) { return ''; }
        const one = m[1].replace(/\s+/g, ' ').trim();
        if (!one) { return ''; }
        return one.length > 90 ? one.slice(0, 89) + '…' : one;
    }

    /**
     * The panel's own record of turns it rendered.
     *
     * agy keeps prompts and tool calls in its transcript but not its replies —
     * those live only in a protobuf blob inside a WAL-backed SQLite, which
     * would mean shipping a WASM SQLite plus a decoder for an undocumented
     * schema, and would rot on any agy release. The panel already HAS the
     * answers at the moment it renders them, so it keeps them.
     *
     * Conversations started in the terminal still fall back to agy's
     * transcript, which is why replayConversation stays.
     */
    private saveTurn(role: 'user' | 'assistant', text: string): void {
        if (!text.trim()) { return; }
        this.pendingTurns.push({ role, text });
        if (this.conversationId) { this.flushTurns(); }
    }

    /** Write the buffered turns once the conversation has an id. */
    private flushTurns(): void {
        const id = this.conversationId;
        if (!id || !this.pendingTurns.length) { return; }
        const queued = this.pendingTurns;
        this.pendingTurns = [];
        const all = this.context.globalState.get<Record<string, { role: string; text: string }[]>>(
            'antigravity.transcripts', {});
        const turns = all[id] || [];
        turns.push(...queued);
        // Bounded on both axes: 60 turns per conversation, 40 conversations.
        // globalState is not a database, and a runaway store would slow every
        // activation.
        all[id] = turns.slice(-60);
        const ids = Object.keys(all);
        if (ids.length > 40) {
            for (const old of ids.slice(0, ids.length - 40)) { delete all[old]; }
        }
        this.context.globalState.update('antigravity.transcripts', all);
    }

    private savedTurns(id: string): { role: string; text: string }[] {
        const all = this.context.globalState.get<Record<string, { role: string; text: string }[]>>(
            'antigravity.transcripts', {});
        return all[id] || [];
    }

    /**
     * Rebuild what a resumed conversation contained, from agy's transcript.
     *
     * The prompts and the tool calls are both in transcript.jsonl. The
     * assistant's prose is NOT — neither transcript.jsonl nor
     * transcript_full.jsonl carries it, and the SQLite store keeps its rows in
     * a WAL, so reading it would mean shipping a SQLite driver the extension
     * host does not have (node:sqlite is Node 22+, VS Code is on 18/20).
     *
     * So this replays what exists and the panel says what is missing. Half a
     * transcript with a note beats an empty panel that looks broken.
     */
    private replayConversation(id: string): void {
        if (!id) { return; }

        // What the panel rendered itself, answers included.
        const mine = this.savedTurns(id);
        if (mine.length) {
            this.post({ type: 'replay', id, turns: mine, full: true });
            return;
        }

        const file = path.join(brainDir(), id, '.system_generated', 'logs', 'transcript.jsonl');
        const turns: { role: string; text: string }[] = [];
        let raw = '';
        try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }

        for (const line of raw.split(/\r?\n/)) {
            const t = line.trim();
            if (!t.startsWith('{')) { continue; }
            let rec: { type?: string; content?: unknown; tool_calls?: unknown };
            try { rec = JSON.parse(t); } catch { continue; }

            if (rec.type === 'USER_INPUT' && typeof rec.content === 'string') {
                // Only the request. The metadata blocks agy appends are its
                // own bookkeeping, not anything the user typed.
                const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(rec.content);
                const text = (m ? m[1] : rec.content).replace(/\s+/g, ' ').trim();
                if (text) { turns.push({ role: 'user', text }); }
            } else if (rec.type === 'PLANNER_RESPONSE' && Array.isArray(rec.tool_calls)) {
                for (const call of rec.tool_calls as { name?: string }[]) {
                    if (call && call.name) { turns.push({ role: 'tool', text: String(call.name) }); }
                }
            }
            if (turns.length >= 200) { break; }
        }
        if (turns.length) {
            const titles = this.context.globalState.get<Record<string, string>>('antigravity.titles', {});
            // Panel-started but from a build before it saved replies, vs a
            // conversation genuinely run in the terminal. Different sentence.
            const known = Object.prototype.hasOwnProperty.call(titles, id);
            this.post({ type: 'replay', id, turns, origin: known ? 'panel' : 'terminal' });
        }
    }

    /**
     * Past conversations, newest first.
     *
     * Read from agy's own store rather than a list we maintain, so sessions
     * started in the terminal show up here too — and now carry the prompt they
     * opened with rather than a timestamp.
     */
    private listSessions(): void {
        const titles = this.context.globalState.get<Record<string, string>>('antigravity.titles', {});
        let entries: { id: string; mtime: number; title: string }[] = [];
        try {
            entries = this.conversationFiles()
                .map((f) => {
                    const id = path.basename(f).replace(/\.db$/, '');
                    return { id, mtime: fs.statSync(f).mtimeMs, title: titles[id] || '' };
                })
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, 30)
                // Only for the rows actually shown: reading every transcript in
                // the store to render thirty of them would be wasteful.
                .map((e) => (e.title ? e : { ...e, title: this.conversationTitle(e.id) }));
        } catch {
            entries = [];
        }
        this.post({ type: 'sessions', sessions: entries, current: this.conversationId });
    }

    /**
     * Broadcast the COMPLETE execution state.
     *
     * The three setters used to post only the field they changed, and the
     * webview reads absent fields as falsy — so changing the mode silently
     * flipped the panel's sandbox indicator to "off" while runs still passed
     * --sandbox. One helper means the shape can no longer drift per call site.
     */
    private postModes(open?: unknown): void {
        this.post({
            type: 'modes',
            mode: this.mode,
            effort: this.effort,
            sandbox: this.sandbox,
            tools: this.tools,
            folders: this.extraWorkspaceDirs().length,
            open,
        });
    }

    /** Workspace folders beyond the first — the first is already the cwd. */
    private extraWorkspaceDirs(): string[] {
        const folders = vscode.workspace.workspaceFolders || [];
        return folders.slice(1).map((f) => f.uri.fsPath);
    }

    /**
     * Skills agy has loaded, read from ~/.agents/skills/<name>/SKILL.md.
     *
     * That directory is agy's own — it warns about conflicts there at startup —
     * so this reports what the CLI will actually use rather than a list this
     * extension invents.
     */
    private listSkills(): void {
        const home = (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || homedir();
        const root = path.join(home, '.agents', 'skills');
        const out: { name: string; description: string }[] = [];
        try {
            for (const dir of fs.readdirSync(root)) {
                const file = path.join(root, dir, 'SKILL.md');
                if (!existsSync(file)) continue;
                const head = fs.readFileSync(file, 'utf8').slice(0, 1500);
                const nameM = /^name:\s*(.+)$/m.exec(head);
                let desc = '';
                const descM = /^description:\s*(.*)$/m.exec(head);
                if (descM) {
                    // "description: >" folds onto the following indented lines,
                    // so a same-line read would come back empty.
                    desc = descM[1].trim();
                    if (!desc || desc === '>' || desc === '|') {
                        const after = head.slice(descM.index + descM[0].length);
                        const folded: string[] = [];
                        for (const line of after.split(/\r?\n/)) {
                            if (!/^\s+\S/.test(line)) break;
                            folded.push(line.trim());
                        }
                        desc = folded.join(' ');
                    }
                }
                out.push({
                    name: (nameM ? nameM[1] : dir).trim(),
                    description: desc.replace(/\s+/g, ' ').trim().slice(0, 90),
                });
            }
        } catch {
            /* no skills directory on this machine */
        }
        this.post({ type: 'skills', skills: out });
    }

    /**
     * MCP servers agy will load, read from ~/.gemini/settings.json.
     *
     * agy has no MCP flag; it picks the servers up from that file, so this
     * reports what the CLI will actually connect to rather than a list this
     * extension keeps. Management stays in the TUI (/mcp) — this is visibility,
     * not a second control surface that could disagree with the first.
     */
    private listMcp(): void {
        const home = (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || homedir();
        const file = path.join(home, '.gemini', 'settings.json');
        const out: { name: string; detail: string }[] = [];
        try {
            const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const [name, def] of Object.entries<any>(cfg.mcpServers || {})) {
                const detail = def?.command
                    ? String(def.command) + (def.args?.length ? ' ' + def.args.join(' ') : '')
                    : def?.url || def?.httpUrl || '';
                out.push({ name, detail: String(detail).slice(0, 70) });
            }
        } catch {
            /* no settings file, or not readable */
        }
        this.post({ type: 'mcp', servers: out });
    }

    /**
     * Local media produced by a turn, rendered inline.
     *
     * agy never hands the picture back over the stream, and it is not
     * consistent about naming it either. Two generate_image turns, both
     * observed:
     *
     *   1. wrote sheep_with_hat_*.jpg AND a sheep_image.md wrapper, and linked
     *      the .md in the reply as a file:// URL;
     *   2. wrote sheep_with_hat_*.jpg alone and said only "Here is the image
     *      of the sheep wearing a hat!" — no path anywhere in the text.
     *
     * So text is not a reliable channel. Read what the text points at when it
     * points at anything, then sweep agy's brain directory for media written
     * while this turn was running. The sweep is what catches case 2.
     */
    private scanMedia(text: string): void {
        const webview = this.view?.webview;
        if (!webview) { return; }
        const seen = new Set<string>();
        const items: { src: string; name: string; kind: string; path: string }[] = [];

        const consider = (raw: string, depth: number): void => {
            if (items.length >= 8 || depth > 2) { return; }
            // Trailing punctuation belongs to the sentence, not the path.
            let p = String(raw || '').trim().replace(/[)\].,;:!?]+$/, '');
            if (/^file:\/\//i.test(p)) {
                try { p = vscode.Uri.parse(p).fsPath; } catch { return; }
            }
            if (!p || !path.isAbsolute(p)) { return; }
            p = path.normalize(p);
            if (seen.has(p)) { return; }
            seen.add(p);
            if (!existsSync(p)) { return; }

            const kind = IMAGE_EXT.test(p) ? 'image' : VIDEO_EXT.test(p) ? 'video' : '';
            if (kind) {
                items.push({
                    src: webview.asWebviewUri(vscode.Uri.file(p)).toString(),
                    name: path.basename(p),
                    kind,
                    path: p,
                });
                return;
            }
            if (!/\.md$/i.test(p)) { return; }
            let body = '';
            try { body = fs.readFileSync(p, 'utf8'); } catch { return; }
            // Markdown image refs only: the closing paren delimits the path, so
            // this survives the spaces in a Windows home directory that a
            // whitespace-split regex would cut in half.
            const re = /!\[[^\]]*\]\(([^)]+)\)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(body))) { consider(m[1], depth + 1); }
        };

        (text.match(/file:\/\/\/\S+/gi) || []).forEach((u) => consider(u, 0));
        // Bare paths, both separators: agy prints C:/... in markdown and C:\...
        // in prose. Anchor on the extension rather than on whitespace, because
        // "C:\Users\Jacob The God\..." has spaces in it and a \S+ run stops at
        // the first one. Drop file:// URLs first or the drive-letter class
        // matches the "e:" inside "file://".
        const bare = text.replace(/file:\/\/\/\S+/gi, ' ');
        const re = /[A-Za-z]:[\\/][^"'<>()\n]*?\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|md)(?=[\s"'<>)\]]|$)/gi;
        (bare.match(re) || []).forEach((u) => consider(u, 0));

        // Then whatever the turn wrote to disk but never mentioned. Ordered
        // newest first so the picture just made leads, and bounded by the turn
        // start so an image from an earlier conversation cannot reappear under
        // an unrelated answer.
        this.freshMedia().forEach((p) => consider(p, 0));

        if (items.length) { this.post({ type: 'media', items }); }
    }

    /**
     * Media written under agy's brain directory since this turn started.
     *
     * Cheap on purpose: two levels deep, extension-filtered before any stat,
     * and capped. The brain holds one directory per conversation, each with a
     * handful of files, so this is a few dozen stats at worst.
     */
    private freshMedia(): string[] {
        const since = this.runStartedAt;
        if (!since) { return []; }
        const root = brainDir();
        const found: { p: string; t: number }[] = [];

        const sweep = (dir: string, depth: number): void => {
            if (depth > 2 || found.length >= 40) { return; }
            let entries: fs.Dirent[] = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    // .system_generated holds transcripts, never media.
                    if (e.name === '.system_generated') { continue; }
                    sweep(full, depth + 1);
                    continue;
                }
                if (!IMAGE_EXT.test(e.name) && !VIDEO_EXT.test(e.name)) { continue; }
                try {
                    const st = fs.statSync(full);
                    // A second of slack: the file is written before the result
                    // event, but clocks and buffering make an exact compare
                    // brittle at the boundary.
                    if (st.mtimeMs >= since - 1000) { found.push({ p: full, t: st.mtimeMs }); }
                } catch { /* vanished mid-sweep */ }
            }
        };

        sweep(root, 0);
        return found.sort((a, b) => b.t - a.t).map((f) => f.p).slice(0, 8);
    }

    /**
     * One directory of the workspace, for the + menu's browser.
     *
     * findFiles answers "what matches this name"; this answers "what is in
     * here", which is what someone reaching for + is asking. Directories sort
     * first so descending is one click, not a hunt.
     */
    private async browseDir(rel: string): Promise<void> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) { this.post({ type: 'tree', dir: '', entries: [] }); return; }
        const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        // Never climb out of the workspace, whatever the webview asks for.
        if (clean.split('/').includes('..')) { this.post({ type: 'tree', dir: '', entries: [] }); return; }

        // Multi-root: the top level lists the folders themselves. Browsing only
        // folders[0] meant three of four open folders were unreachable from +,
        // even though --add-dir already puts them all in agy's scope.
        if (!clean && folders.length > 1) {
            this.post({
                type: 'tree',
                dir: '',
                entries: folders.map((f) => ({ name: f.name, dir: true, rel: f.name })),
            });
            return;
        }

        // Paths are rooted at a folder NAME once there is more than one, so the
        // first segment selects which root rather than being a child of one.
        let root = folders[0].uri;
        let rest = clean;
        if (folders.length > 1) {
            const [head, ...tail] = clean.split('/');
            const match = folders.find((f) => f.name === head);
            if (!match) { this.post({ type: 'tree', dir: '', entries: [] }); return; }
            root = match.uri;
            rest = tail.join('/');
        }
        const dir = rest ? vscode.Uri.joinPath(root, rest) : root;
        let raw: [string, vscode.FileType][] = [];
        try { raw = await vscode.workspace.fs.readDirectory(dir); } catch { /* unreadable */ }
        const SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.vscode-test']);
        const entries = raw
            .filter(([n]) => !SKIP.has(n))
            .map(([n, t]) => ({
                name: n,
                dir: (t & vscode.FileType.Directory) !== 0,
                rel: clean ? clean + '/' + n : n,
            }))
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
            .slice(0, 300);
        this.post({ type: 'tree', dir: clean, entries });
    }

    /**
     * Put real counts on the rows that describe collections.
     *
     * "Custom skills agy has loaded" does not say whether you have any. The
     * numbers come from the same places the commands themselves read, so a row
     * saying "2 skills" cannot disagree with what opening it shows.
     */
    private annotate<T extends { name: string; description: string }>(rows: T[]): T[] {
        const home = (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || homedir();
        const count = (fn: () => number): number => {
            try { return fn(); } catch { return 0; }
        };
        const skills = count(() =>
            fs.readdirSync(path.join(home, '.agents', 'skills'))
                .filter((d) => existsSync(path.join(home, '.agents', 'skills', d, 'SKILL.md')))
                .length);
        const servers = count(() => {
            const cfg = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
            return Object.keys(cfg.mcpServers || {}).length;
        });
        const plural = (n: number, one: string) => n + ' ' + one + (n === 1 ? '' : 's');
        return rows.map((r) => {
            if (r.name === '/skills') {
                return { ...r, description: skills ? plural(skills, 'skill') : 'none installed' };
            }
            if (r.name === '/mcp') {
                return { ...r, description: servers ? plural(servers, 'server') : 'none configured' };
            }
            return r;
        });
    }

    /** Workspace files for @-mentions, so context can be added by name. */
    private async findFiles(query: string): Promise<void> {
        const q = query.replace(/^@/, '').trim();
        try {
            const uris = await vscode.workspace.findFiles(
                q ? `**/*${q}*` : '**/*',
                '**/{node_modules,.git,out,dist,build}/**',
                40
            );
            this.post({
                type: 'files',
                files: uris.map((u) => ({
                    rel: vscode.workspace.asRelativePath(u, false),
                    name: path.basename(u.fsPath),
                })),
            });
        } catch {
            this.post({ type: 'files', files: [] });
        }
    }

    /** `agy agents` — the CLI's own list, empty until the user defines some. */
    private listAgents(): void {
        const cli = this.resolveAgy();
        if (!cli) {
            this.post({ type: 'agents', agents: [] });
            return;
        }
        let child: ChildProcess;
        try {
            child = spawn(cli, ['agents'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        } catch {
            this.post({ type: 'agents', agents: [] });
            return;
        }
        let out = '';
        child.stdout?.on('data', (b) => { out += b.toString('utf8'); });
        child.on('error', () => this.post({ type: 'agents', agents: [] }));
        child.on('close', () => {
            const agents = out
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l && !/^available agents/i.test(l));
            this.post({ type: 'agents', agents });
        });
    }

    private conversationFiles(): string[] {
        const dir = conversationsDir();
        try {
            return fs.readdirSync(dir)
                .filter((f) => f.endsWith('.db'))
                .map((f) => path.join(dir, f));
        } catch {
            return [];
        }
    }

    /**
     * Remember the opening prompt as a conversation's title.
     *
     * Scraping the SQLite blobs was tried and abandoned: agy's system prompt
     * dominates the printable bytes, so every conversation extracted the SAME
     * sentence — a label that looks like data while distinguishing nothing,
     * which is worse than showing the id. Instead, when a fresh turn creates a
     * new .db, that file is the conversation agy just made, so its name is the
     * id and the prompt we sent is the honest title. Conversations started in
     * the terminal keep a timestamp, because we genuinely do not know them.
     */
    private captureTitle(before: Set<string>, prompt: string, epoch: number): void {
        // The user reset the session while this run was closing — its id is no
        // longer the conversation they are looking at.
        if (epoch !== this.epoch) return;
        const fresh = this.conversationFiles().filter((f) => !before.has(f));
        if (fresh.length !== 1) return; // ambiguous — better no title than a wrong one
        const id = path.basename(fresh[0]).replace(/\.db$/, '');
        const titles = { ...this.context.globalState.get<Record<string, string>>('antigravity.titles', {}) };
        titles[id] = prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
        this.context.globalState.update('antigravity.titles', titles);
        this.conversationId = id; // later turns resume this exact conversation
        // The id exists now, so the turns buffered during this run have a home.
        this.flushTurns();
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        // The conversation survives a tab switch because the provider is
        // registered with retainContextWhenHidden (see extension.ts). Retention
        // is a registration option, not a webview.options one, so it is set
        // there rather than here.
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                // Pasted images live here; without this root the thumbnails
                // would silently fail to load.
                this.context.globalStorageUri,
                // agy writes generated images and their .md artifact wrappers
                // under its own brain directory, which is outside both of the
                // roots above — without it every generated picture is a dead
                // link the user has to open by hand.
                vscode.Uri.file(brainDir()),
                ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri),
            ],
        };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
        view.onDidDispose(() => this.kill());
    }

    private onMessage(msg: any): void {
        if (!msg) return;
        switch (msg.type) {
            case 'ready':
                // Tell the panel which build it is. Three rounds of "is this
                // shipped?" were actually stale webviews, and a version you can
                // read settles that without inspecting the extensions folder.
                {
                    const pkg = this.context.extension?.packageJSON || {};
                    this.post({
                        type: 'version',
                        version: pkg.version || '',
                        // Whoever the manifest credits — no second copy of the
                        // name to drift out of sync with package.json.
                        author: pkg.author?.name || pkg.publisher || '',
                    });
                }
                this.probe();
                // Tool access is on unless it was turned off. Say so once,
                // because "it can read my files" is the user's call to revisit,
                // not a detail to discover from behaviour.
                if (!this.toolsChosen) {
                    this.post({
                        type: 'toolsNotice',
                        text: 'Tool access is on, so agy can read files and run commands in ' +
                            'this workspace without asking each time. Turn it off in ' +
                            '/effort if you would rather it could not.',
                    });
                    this.context.globalState.update('antigravity.toolsChosen', true);
                }
                break;
            case 'connect':
                // Reconnect cancels whatever is in flight: the button exists to
                // recover from a stuck turn, so leaving the old process running
                // would defeat the point.
                if (msg.type === 'connect') this.kill();
                this.probe();
                break;
            case 'send':
                this.run(String(msg.text || ''));
                break;
            case 'stop':
                this.kill();
                this.post({ type: 'done', stopped: true });
                break;
            case 'listModels':
                this.listModels(!!msg.open);
                break;
            case 'listSlash': {
                const q = String(msg.query || '');
                const bare = q.trim() === '' || q.trim() === '/';
                // The menu scrolls, so the full catalog is browsable when it is
                // opened cold. Truncating to twelve while typing keeps a search
                // tight; truncating the browse view just hid commands.
                const all = filterSlashCommands(q);
                this.post({
                    type: 'slash',
                    commands: this.annotate(bare ? all : all.slice(0, 12)),
                });
                break;
            }
            case 'setModel':
                this.context.globalState.update('antigravity.model', String(msg.model || ''));
                this.post({ type: 'models', models: msg.models || [], current: String(msg.model || '') });
                break;
            case 'listModes':
                this.postModes(msg.open);
                break;
            case 'setMode':
                this.context.globalState.update('antigravity.mode', String(msg.mode ?? ''));
                this.postModes();
                break;
            case 'setTools':
                this.context.globalState.update('antigravity.tools', !!msg.on);
                this.context.globalState.update('antigravity.toolsChosen', true);
                this.postModes();
                break;
            case 'setSandbox':
                this.context.globalState.update('antigravity.sandbox', !!msg.on);
                this.postModes();
                break;
            case 'setEffort':
                this.context.globalState.update('antigravity.effort', String(msg.effort ?? ''));
                this.postModes();
                break;
            case 'listMcp':
                this.listMcp();
                break;
            case 'browse':
                this.browseDir(String(msg.path || ''));
                break;
            case 'findFiles':
                this.findFiles(String(msg.query || ''));
                break;
            case 'listSkills':
                this.listSkills();
                break;
            case 'listAgents':
                this.listAgents();
                break;
            case 'listFolders':
                this.post({
                    type: 'folders',
                    folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
                });
                break;
            case 'listSessions':
                this.listSessions();
                break;
            case 'resumeSession':
                this.resetTo(String(msg.id || ''));
                // Show what the conversation contained. Picking one out of
                // History used to leave the panel on its empty state, which
                // read as "nothing happened" rather than "resumed".
                this.replayConversation(this.conversationId);
                break;
            case 'newSession':
                this.resetTo('');
                break;
            case 'attach':
                this.attach();
                break;
            case 'pasteImage':
                this.savePastedImage(String(msg.data || ''), String(msg.ext || 'png'));
                break;
            case 'openRepo': {
                const url = String(this.context.extension?.packageJSON?.repository?.url || '')
                    .replace(/^git\+/, '')
                    .replace(/\.git$/, '');
                if (/^https:\/\//i.test(url)) {
                    vscode.env.openExternal(vscode.Uri.parse(url));
                }
                break;
            }
            case 'openPermissions':
                this.openPermissions();
                break;
        }
    }

    /**
     * Attach files (images included) by reference.
     *
     * agy reads attachments itself via `@path`; the bytes are never inlined
     * into the prompt. That keeps large images out of the argv and lets agy
     * decide how to handle each type — but it does mean the read goes through
     * agy's tool permissions, which is what the auto-deny hint is about.
     */
    private async attach(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach to Antigravity',
            filters: {
                'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
                'All files': ['*'],
            },
        });
        if (!picked || !picked.length) return;
        const refs = picked.map((u) => {
            const rel = vscode.workspace.asRelativePath(u, false);
            // Relative when inside the workspace (shorter and agy resolves it
            // against cwd); absolute otherwise, or agy would not find it.
            return '@' + (rel !== u.fsPath ? rel : u.fsPath);
        });
        this.post({ type: 'attached', refs });
    }

    /**
     * Write a pasted image to disk and hand back a path agy can read.
     *
     * The clipboard gives bytes, but agy takes a `@path` — so the bytes have to
     * land somewhere first. They go to the extension's own storage directory,
     * not the workspace, because a screenshot pasted into a chat is not
     * something the user asked to add to their repo (and would show up in git
     * status if it were).
     */
    private async savePastedImage(dataUrl: string, ext: string): Promise<void> {
        const m = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(dataUrl);
        if (!m) {
            this.post({ type: 'pasteFailed', reason: 'clipboard did not contain an image' });
            return;
        }
        try {
            const dir = path.join(this.context.globalStorageUri.fsPath, 'pasted');
            fs.mkdirSync(dir, { recursive: true });
            const safeExt = /^[a-z]{2,5}$/i.test(ext) ? ext.toLowerCase() : 'png';
            // Counter, not a timestamp: Date.now() collides when two images are
            // pasted inside the same millisecond, which a multi-image paste does.
            const file = path.join(dir, `paste-${Date.now()}-${this.pasteSeq++}.${safeExt}`);
            fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
            this.post({
                type: 'pasted',
                path: file,
                // The webview cannot read arbitrary disk paths under its CSP, so
                // send back a webview-safe URI for the thumbnail.
                src: this.view?.webview.asWebviewUri(vscode.Uri.file(file))?.toString() || '',
                name: path.basename(file),
            });
        } catch (e: any) {
            this.post({ type: 'pasteFailed', reason: String(e?.message || e) });
        }
    }

    /** Open agy's settings.json so the user can add the allow-rule themselves.
     *  Deliberately not written for them: the remedy agy suggests grants
     *  command execution, which is not a choice to make on someone's behalf. */
    private async openPermissions(): Promise<void> {
        const home = (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || homedir();
        const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
        try {
            if (!existsSync(file)) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, '{\n}\n', 'utf8');
            }
            const doc = await vscode.workspace.openTextDocument(file);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(
                'Add an allow-rule, e.g. "permissions": { "allow": ["command(git)"] }. ' +
                'Broad rules let agy run commands without asking — scope them to what you need.'
            );
        } catch (e: any) {
            vscode.window.showErrorMessage(`Antigravity: could not open settings.json — ${e?.message || e}`);
        }
    }

    /**
     * Check the CLI is reachable and report its version.
     *
     * `agy --version` answers in ~400ms even when a prompt in the same repo
     * takes 20s+, so this is a cheap, honest connection check — it proves the
     * binary runs, without claiming anything about model latency.
     */
    private probe(): void {
        const cli = this.resolveAgy();
        if (!cli) {
            this.post({
                type: 'status',
                connected: false,
                detail:
                    'agy not found. Install the Antigravity CLI, or set ' +
                    'antigravity.command to its full path.',
            });
            return;
        }

        this.post({ type: 'status', connecting: true, path: cli });
        let out = '';
        let err = '';
        let settled = false;
        const finish = (payload: any) => {
            if (settled) return;
            settled = true;
            this.post(payload);
        };

        try {
            const child = spawn(cli, ['--version'], {
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
            });
            const timer = setTimeout(() => {
                try { child.kill(); } catch { /* ignore */ }
                finish({
                    type: 'status',
                    connected: false,
                    detail: 'agy did not respond to --version within 15s.',
                });
            }, 15000);

            child.stdout?.on('data', (b) => { out += b.toString('utf8'); });
            child.stderr?.on('data', (b) => { err += b.toString('utf8'); });
            child.on('error', (e) => {
                clearTimeout(timer);
                finish({ type: 'status', connected: false, detail: e.message });
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                const version = (out.match(/\d+\.\d+\.\d+/) || [])[0] || out.trim().split('\n')[0];
                if (code === 0 && version) {
                    finish({ type: 'status', connected: true, version, path: cli });
                } else {
                    finish({
                        type: 'status',
                        connected: false,
                        detail: (err || out).trim().slice(0, 200) || `agy --version exited ${code}.`,
                    });
                }
            });
        } catch (e: any) {
            finish({ type: 'status', connected: false, detail: String(e?.message || e) });
        }
    }

    /**
     * Translate one stream-json event into something the panel can draw.
     *
     * Only steps that mean something to a reader are forwarded. `checkpoint`
     * and `unknown` steps are agy's own bookkeeping — showing them would be
     * noise dressed as progress.
     */
    private onEvent(ev: any): void {
        if (ev.event === 'init') {
            this.post({
                type: 'init',
                tools: (ev.init?.tools || []).length,
                permissionMode: ev.init?.permission_mode || '',
            });
            return;
        }

        if (ev.event === 'step_update') {
            // Remember that a tool was refused. agy does not fail the turn over
            // it — the model just works around the missing tool and answers
            // anyway, which is how "list_dir failed" turned into a request for
            // paths the user had already given.
            if (ev.step_update?.step_type === 'tool' &&
                String(ev.step_update?.state).toUpperCase() === 'ERROR') {
                this.toolDenied = true;
            }
            const s = ev.step_update || {};
            if (s.step_type === 'tool') {
                this.post({
                    type: 'tool',
                    index: s.step_index,
                    name: s.tool_name || 'tool',
                    state: s.state,                       // ACTIVE | DONE | ERROR
                    seconds: s.duration_seconds,
                });
            } else if (s.text_delta) {
                // The prose arrives here, so streaming survives the switch to
                // structured output rather than being traded away for it.
                this.post({ type: 'chunk', text: s.text_delta });
            }
            if (s.usage) this.post({ type: 'usage', usage: s.usage });
            return;
        }

        if (ev.event === 'result') {
            const r = ev.result || {};
            if (r.usage) this.post({ type: 'usage', usage: r.usage, final: true });
            // The full answer is repeated here. It is only used when no
            // text_delta arrived, so a normal turn is not rendered twice.
            const answer = String(r.response || '');
            this.post({ type: 'resultText', text: answer, status: r.status });
            this.saveTurn('assistant', answer);
            // Say so. A turn where the tools were refused still reads as a
            // normal answer, and the user is left believing agy looked.
            if (this.toolDenied && !this.tools) {
                this.post({
                    type: 'toolsDenied',
                    text: 'A tool was denied. Tool access is off, and agy cannot ask ' +
                        'for permission from a panel — so reading files and running ' +
                        'commands failed for this turn.',
                });
            }
            // Scan the finished answer, not the deltas: a path can straddle two
            // chunks, and half a filename resolves to nothing.
            this.scanMedia(answer);
        }
    }

    /** Spawn one `agy -p` and stream its stdout into the active bubble. */
    private run(prompt: string): void {
        const text = prompt.trim();
        if (!text) return;
        this.kill(); // one turn at a time; a new send cancels an in-flight one
        this.runStartedAt = Date.now();
        this.toolDenied = false;
        this.saveTurn('user', text);

        const cli = this.resolveAgy();
        if (!cli) {
            this.post({
                type: 'error',
                text:
                    "Couldn't find the Antigravity CLI (agy). Set " +
                    "antigravity.command to its full path, or run `agy install`.",
            });
            this.post({ type: 'done' });
            return;
        }

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir();
        this.post({ type: 'start' });

        // shell selection is load-bearing on Windows, and getting it wrong makes
        // the panel silently do nothing:
        //   - an absolute path ("...\Jacob The God\...\agy.exe") through a shell
        //     splits on the space and dies with "'C:\Users\Jacob' is not
        //     recognized". So resolved paths spawn WITHOUT a shell — CreateProcess
        //     takes the argv array verbatim, spaces and all.
        //   - the bare "agy" fallback isn't a real file, so it needs the shell to
        //     resolve it against PATH.
        // Either way the prompt stays a separate argv element, never concatenated.
        // Conversation continuity, in priority order:
        //   --conversation <id>  resume the one picked from history
        //   -c                   continue the one this panel already started
        //   (neither)            start fresh
        // agy holds the history itself, so no transcript is threaded through.
        const args: string[] = [];
        if (this.conversationId) {
            args.push('--conversation', this.conversationId);
        } else if (this.started) {
            args.push('-c');
        }
        if (this.model) args.push('--model', this.model);
        // Verified against agy 1.1.5: --mode accepts plan | accept-edits and
        // --effort accepts low | medium | high. Auto simply omits --mode, which
        // leaves agy on its own default rather than guessing a value for it.
        if (this.mode) args.push('--mode', this.mode);
        if (this.effort) args.push('--effort', this.effort);
        if (this.sandbox) args.push('--sandbox');
        // Without this every file tool is auto-denied; see the `tools` getter.
        if (this.tools) args.push('--dangerously-skip-permissions');
        // Multi-root workspaces: cwd covers only the first folder, so agy was
        // blind to every other one the user has open. --add-dir puts them in
        // scope (verified rc=0), which matters here because a question about a
        // sibling folder would otherwise be answered as if it did not exist.
        for (const dir of this.extraWorkspaceDirs()) args.push('--add-dir', dir);
        // Undocumented in --help, but real in 1.1.5 and the reason this panel
        // can show tool rows and token counts at all: NDJSON events instead of
        // bare prose. Confirmed shape:
        //   {"event":"init",       "init":{cwd,tools,permission_mode}}
        //   {"event":"step_update","step_update":{step_index,state,step_type,
        //        tool_name?,text_delta?,duration_seconds?,usage?}}
        //   {"event":"result",     "result":{status,response,usage,num_turns}}
        // Invalid flags are rejected outright ("flags provided but not
        // defined"), so this one being accepted is how we know it exists.
        args.push('--output-format', 'stream-json');
        args.push('-p', text);

        // Snapshot before a fresh conversation so the new .db can be identified.
        const before = new Set(this.conversationId ? [] : this.conversationFiles());
        const isFresh = !this.conversationId;
        const epoch = this.epoch;

        // shell:false, always. resolveAgy() returns an absolute path, so the
        // argv array reaches CreateProcess verbatim and the prompt can never be
        // reinterpreted as shell syntax.
        const child = spawn(cli, args, {
            cwd,
            shell: false,
            // stdin MUST be closed. agy's own help says --print is "appended to
            // input on stdin (if any)", so with Node's default pipe it waits for
            // an EOF that never comes: `agy models` hung for 25s+ and returned
            // nothing, while the identical call with stdin ignored closed in
            // 3.2s with all 11 models. This was slowing every turn, not just the
            // model list.
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        this.started = true;
        this.current = child;

        let produced = false;
        let ndjson = '';        // partial line carry-over
        let sawEvent = false;   // did stream-json actually engage?

        child.stdout?.on('data', (buf) => {
            const s = buf.toString('utf8');
            if (s.trim()) produced = true;
            ndjson += s;
            for (;;) {
                const nl = ndjson.indexOf('\n');
                if (nl < 0) break;
                const line = ndjson.slice(0, nl).trim();
                ndjson = ndjson.slice(nl + 1);
                if (!line) continue;
                let ev: any;
                try {
                    ev = JSON.parse(line);
                } catch {
                    // Not JSON: an agy without --output-format would print prose
                    // here. Fall back rather than swallow the answer.
                    this.post({ type: 'chunk', text: line + '\n' });
                    continue;
                }
                sawEvent = true;
                this.onEvent(ev);
            }
        });
        // agy prints spinners/notices to stderr; keep them out of the answer but
        // hold the last line so a non-zero exit can say something useful.
        let lastErr = '';
        child.stderr?.on('data', (buf) => {
            const s = buf.toString('utf8').trim();
            if (s) lastErr = s;
        });
        child.on('error', (err) => {
            this.post({ type: 'error', text: err.message });
            if (ndjson.trim() && !sawEvent) this.post({ type: 'chunk', text: ndjson });
            if (isFresh) this.captureTitle(before, text, epoch);
            this.post({ type: 'done' });
            this.current = undefined;
        });
        child.on('close', (code) => {
            // Drain a final line with no trailing newline. NDJSON is split on
            // \n, so a last line agy did not terminate — which can be the
            // result event carrying the whole answer — would otherwise sit in
            // the buffer unparsed: the reply lost, and never saved.
            const tail = ndjson.trim();
            ndjson = '';
            if (tail) {
                try { this.onEvent(JSON.parse(tail)); sawEvent = true; }
                catch { this.post({ type: 'chunk', text: tail + '\n' }); }
            }

            // The failure that matters most is invisible otherwise: agy exits 0
            // with EMPTY stdout when a tool needs a permission headless mode
            // cannot prompt for. Without this branch the panel renders a blank
            // assistant bubble and looks broken for any prompt that reads a
            // file — which is most real questions.
            const denied = /auto-denied|no output produced/i.test(lastErr);
            if (denied && !produced) {
                this.post({
                    type: 'error',
                    text:
                        'agy produced no output: a tool needed a permission that ' +
                        'headless mode cannot ask about, so it was auto-denied. ' +
                        'This affects prompts that read files or run commands.',
                    needsPermission: true,
                });
            } else if (code && code !== 0) {
                this.post({
                    type: 'error',
                    text: lastErr || `agy exited with code ${code}.`,
                });
            } else if (!produced) {
                this.post({
                    type: 'error',
                    text: lastErr || 'agy returned no output.',
                });
            }
            this.post({ type: 'done' });
            this.current = undefined;
        });
    }

    private kill(): void {
        if (!this.current) return;
        const child = this.current;
        this.current = undefined;
        try {
            if (IS_WIN && child.pid) {
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
            } else {
                child.kill('SIGTERM');
            }
        } catch {
            /* best effort */
        }
    }

    /**
     * Resolve agy to an ABSOLUTE path: config → known install dirs → PATH.
     *
     * Always absolute, never a bare name, because a bare name previously forced
     * `shell: true` on the spawn — and Node does not escape argv under a shell,
     * it concatenates it. The prompt is an argv element, so a message containing
     * `&` ran a second command. Verified: the same payload created a file with
     * shell:true and did nothing with shell:false. Walking PATH here keeps every
     * spawn shell-free, which removes the injection surface rather than trying
     * to sanitise around it.
     */
    private resolveAgy(): string | undefined {
        const configured = vscode.workspace
            .getConfiguration('antigravity')
            .get<string>('command', '')
            .trim();
        if (configured && configured !== 'agy') {
            return existsSync(configured) ? configured : undefined;
        }

        const home = (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || homedir();
        const names = IS_WIN ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'] : ['agy'];
        const dirs = [
            path.join(home, 'AppData', 'Local', 'agy', 'bin'),
            path.join(home, '.agy', 'bin'),
            // PATH last: the known install dirs are more specific, and this is
            // only here so a PATH-only install still resolves to a real file.
            ...(process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean),
        ];
        for (const dir of dirs) {
            for (const name of names) {
                try {
                    const p = path.join(dir, name);
                    if (existsSync(p)) return p;
                } catch {
                    /* unreadable PATH entry — keep looking */
                }
            }
        }
        return undefined;
    }

    private post(msg: any): void {
        this.view?.webview.postMessage(msg);
    }

    private nonce(): string {
        let s = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
    }

    private html(webview: vscode.Webview): string {
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agy');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
        const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
        const mdjs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'markdown.js'));
        const n = this.nonce();
        const csp =
            `default-src 'none'; img-src ${webview.cspSource} data:; ` +
            `style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';`;
        return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${css}">
</head><body>
<div class="statusbar">
  <span class="grow"></span>
  <button id="historyBtn" class="chipbtn icon" type="button" title="Past conversations" aria-label="Past conversations">
    <svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M8 3.5a4.5 4.5 0 1 0 4.35 5.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 5.2V8l2 1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 3.2v2.6h-2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  <button id="newBtn" class="chipbtn icon" type="button" title="New conversation" aria-label="New conversation">
    <svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M8 3.6v8.8M3.6 8h8.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
</div>
<div id="pickerTop" class="picker picker-top" hidden></div>
<div id="log" class="log"></div>
<div id="picker" class="picker" hidden></div>
<form id="composer" class="composer">
  <div class="inputwrap">
    <div id="queue" class="queue" hidden></div>
    <div id="tray" class="tray" hidden></div>
    <textarea id="input" rows="1" placeholder="Ask Antigravity…" spellcheck="false"></textarea>
    <button id="micBtn" class="micbtn" type="button" title="Dictate" hidden>
      <svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><rect x="6" y="2.4" width="4" height="7" rx="2" fill="currentColor"/><path d="M4 7.6a4 4 0 0 0 8 0M8 11.6v2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
    <div class="tools">
      <button id="plusBtn" class="toolbtn" type="button" title="Attach a file or image">
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg></button>
      <button id="slashBtn" class="toolbtn" type="button" title="Commands">
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M10.4 2.9 5.6 13.1" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg></button>
      <span class="grow"></span>
      <span id="usage" class="usage" hidden></span>
      <span id="modelBtn" class="modelchip" title="Switch model (/model)">Default</span>
      <span id="effortBtn" class="modelchip effortchip" title="Reasoning effort (/effort)">
        <svg viewBox="0 0 16 16" class="gauge" aria-hidden="true"><rect class="b1" x="2.2" y="9.4" width="2.6" height="4.4" rx="1"/><rect class="b2" x="6.7" y="6.6" width="2.6" height="7.2" rx="1"/><rect class="b3" x="11.2" y="3.4" width="2.6" height="10.4" rx="1"/></svg><span id="effortText">Default</span></span>
      <span id="modeBtn" class="modelchip modechip" title="Execution mode (/mode)">
        <svg viewBox="0 0 16 16" class="bolt" aria-hidden="true"><path d="M9 2 4 9h3.2L7 14l5-7H8.8L9 2z" fill="currentColor"/></svg><span id="modeText">Auto</span></span>
      <button id="send" class="sendbtn" type="submit" title="Send">
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M8 12.6V3.8M4.4 7.4 8 3.6l3.6 3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
  </div>
</form>
<script nonce="${n}" src="${mdjs}"></script>
<script nonce="${n}" src="${js}"></script>
</body></html>`;
    }
}
