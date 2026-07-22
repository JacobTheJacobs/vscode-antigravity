import * as vscode from 'vscode';
import { AgyChatViewProvider } from './agy/AgyChatViewProvider';

/**
 * Antigravity — a docked Gemini chat panel backed by the `agy` CLI.
 *
 * `agy` authenticates through Google AI Pro (the tier the plain gemini CLI's
 * personal login can no longer reach) and streams `agy -p` output token-by-
 * token, which the panel renders live.
 */
export function activate(context: vscode.ExtensionContext): void {
    const provider = new AgyChatViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            AgyChatViewProvider.viewId,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),

        vscode.commands.registerCommand('antigravity.askAboutSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('Antigravity: open a file and select some code first.');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection.trim()) {
                vscode.window.showInformationMessage('Antigravity: nothing selected.');
                return;
            }
            const question = await vscode.window.showInputBox({
                prompt: 'Ask Antigravity about the selection',
                placeHolder: 'What does this do? / Find the bug / Refactor this…',
                value: 'Explain this code.',
            });
            if (!question) return;

            // Reference the file by path and line rather than only pasting the
            // text: agy runs in the workspace and can open the file itself, so
            // it keeps the surrounding context the selection alone would lose.
            const rel = vscode.workspace.asRelativePath(editor.document.uri);
            const start = editor.selection.start.line + 1;
            const end = editor.selection.end.line + 1;
            const lang = editor.document.languageId;
            const prompt =
                `${question}\n\n` +
                `File: ${rel} (lines ${start}-${end})\n\n` +
                '```' + lang + '\n' + selection + '\n```';

            await provider.ask(prompt);
        }),

        vscode.commands.registerCommand('antigravity.newSession', () => provider.newSession()),
    );
}

export function deactivate(): void {
    /* the webview provider disposes with the subscription */
}
