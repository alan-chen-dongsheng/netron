import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class NetronEditorProvider implements vscode.CustomReadonlyEditorProvider {

    /** Map from document URI string → active WebviewPanel, for the "Load Color Map" command. */
    private readonly _panels = new Map<string, vscode.WebviewPanel>();

    public static register(context: vscode.ExtensionContext): vscode.Disposable[] {
        const provider = new NetronEditorProvider(context);
        const editorDisposable = vscode.window.registerCustomEditorProvider(
            'netron.modelView',
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        );

        // Command: pick a color-map JSON and send it to the currently-focused model editor.
        const cmdDisposable = vscode.commands.registerCommand('netron.loadColorMap', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'JSON Color Map': ['json'] },
                title: 'Select Netron Color Map JSON',
            });
            if (!uris || uris.length === 0) { return; }
            let colorMap: Record<string, string>;
            try {
                colorMap = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));
            } catch (e) {
                vscode.window.showErrorMessage(`Netron: failed to parse color map – ${e instanceof Error ? e.message : String(e)}`);
                return;
            }
            // Find the active model editor panel.
            const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
            const panel = activeUri ? provider._panels.get(activeUri) : [...provider._panels.values()].at(-1);
            if (!panel) {
                vscode.window.showWarningMessage('Netron: no open model editor found.');
                return;
            }
            panel.webview.postMessage({ command: 'colorMap', colorMap });
        });

        return [editorDisposable, cmdDisposable];
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        try {
            // Netron's source/ directory lives one level above this extension's directory
            const netronSourcePath = path.join(this.context.extensionPath, '..', 'source');
            const netronSourceUri = vscode.Uri.file(netronSourcePath);

            // Also allow the model file's directory so the webview can XHR-load the file
            const fileDir = vscode.Uri.file(path.dirname(document.uri.fsPath));

            webviewPanel.webview.options = {
                enableScripts: true,
                localResourceRoots: [this.context.extensionUri, netronSourceUri, fileDir],
            };

            // Convert the model file URI to a webview-accessible resource URI.
            // We send this URL to the webview; it loads the file via XHR, avoiding
            // the JSON-serialization corruption of Uint8Array in postMessage.
            const fileWebviewUri = webviewPanel.webview.asWebviewUri(document.uri).toString();

            webviewPanel.webview.html = this._buildHtml(
                webviewPanel.webview,
                netronSourceUri,
                path.basename(document.uri.fsPath)
            );

            // Track this panel so the "Load Color Map" command can find it.
            const docKey = document.uri.toString();
            this._panels.set(docKey, webviewPanel);
            webviewPanel.onDidDispose(() => this._panels.delete(docKey));

            // Auto-detect a color-map JSON: <modelPath>.colors.json
            const colorMap = this._tryLoadColorMap(document.uri.fsPath);

            // Persistent message listener: handles 'ready' (send open) and 'export' (save file).
            let opened = false;
            webviewPanel.webview.onDidReceiveMessage(async (msg: { command: string; name?: string; mime?: string; data?: string }) => {
                if (msg.command === 'ready' && !opened) {
                    opened = true;
                    webviewPanel.webview.postMessage({
                        command: 'open',
                        name: path.basename(document.uri.fsPath),
                        url: fileWebviewUri,
                        colorMap: colorMap ?? undefined,
                    });
                } else if (msg.command === 'export' && msg.name && msg.data) {
                    await this._handleExport(document.uri, msg.name, msg.data);
                }
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Netron: failed to open editor – ${message}`);
            throw err; // re-throw so VS Code logs the stack
        }
    }

    /**
     * Try to load a color-map JSON from `<modelPath>.colors.json`.
     * Returns the parsed object, or null if the file doesn't exist or fails to parse.
     */
    private _tryLoadColorMap(modelFsPath: string): Record<string, string> | null {
        const colorMapPath = modelFsPath + '.colors.json';
        try {
            if (fs.existsSync(colorMapPath)) {
                const raw = JSON.parse(fs.readFileSync(colorMapPath, 'utf8'));
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    return raw as Record<string, string>;
                }
            }
        } catch (_) {
            // Silently ignore; color map is optional
        }
        return null;
    }

    /**
     * Handle an export request from the webview.
     * Shows VS Code's native Save dialog, then writes the base64-encoded file.
     */
    private async _handleExport(modelUri: vscode.Uri, name: string, base64Data: string): Promise<void> {
        const ext = path.extname(name).toLowerCase().replace('.', '');
        const filters: { [name: string]: string[] } = ext === 'svg'
            ? { 'SVG Image': ['svg'] }
            : { 'PNG Image': ['png'] };
        const defaultUri = vscode.Uri.file(path.join(path.dirname(modelUri.fsPath), name));
        const saveUri = await vscode.window.showSaveDialog({ defaultUri, filters, title: 'Export Model Graph' });
        if (!saveUri) { return; }
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            await vscode.workspace.fs.writeFile(saveUri, buffer);
            vscode.window.showInformationMessage(`Netron: saved to ${path.basename(saveUri.fsPath)}`);
        } catch (e) {
            vscode.window.showErrorMessage(`Netron: export failed – ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private _buildHtml(
        webview: vscode.Webview,
        netronSourceUri: vscode.Uri,
        title: string
    ): string {
        const src = (filename: string) =>
            webview.asWebviewUri(vscode.Uri.joinPath(netronSourceUri, filename)).toString();

        const netronSourceWebviewUri = webview.asWebviewUri(netronSourceUri).toString();

        const bridgeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vscode-bridge.js')
        ).toString();

        const csp = [
            `default-src 'none'`,
            `script-src ${webview.cspSource} blob:`,
            `worker-src ${webview.cspSource} blob:`,
            `connect-src ${webview.cspSource}`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `img-src ${webview.cspSource} data: blob:`,
            `font-src ${webview.cspSource}`,
        ].join('; ');

        const indexHtmlPath = path.join(netronSourceUri.fsPath, 'index.html');
        let html = fs.readFileSync(indexHtmlPath, 'utf8');

        // 1. Replace CSP
        html = html.replace(
            /<meta http-equiv="Content-Security-Policy"[^>]*>/,
            `<meta http-equiv="Content-Security-Policy" content="${csp}">`
        );

        // 2. Force light color-scheme so prefers-color-scheme:dark never triggers.
        //    Without this, VS Code's dark theme causes grapher.css dark-mode rules
        //    to override the per-category node fill colors, making the graph monochrome.
        //    Inject netron-base meta tag at the same time for the module loader fix.
        html = html.replace(
            '<meta charset="utf-8">',
            `<meta charset="utf-8">\n<meta name="color-scheme" content="light">\n<meta name="netron-base" content="${netronSourceWebviewUri}">`
        );

        // 3. Replace grapher.css with webview URI
        html = html.replace(
            /href="grapher\.css"/,
            `href="${src('grapher.css')}"`
        );

        // 4. Load index.js first (it defines window.exports), then vscode-bridge.js
        //    overrides window.exports.require with the correct base URL.
        //    The 'load' event fires after both scripts run, so preload() picks up
        //    the fixed require automatically.
        html = html.replace(
            /src="index\.js"/,
            `src="${src('index.js')}"></script>\n<script type="text/javascript" src="${bridgeUri}"`
        );

        // 5. Inject light-mode color overrides AFTER grapher.css.
        //    grapher.css has @media(prefers-color-scheme:dark) rules that override
        //    the per-category node fill colors (making the graph monochrome in VS Code's
        //    dark theme). Since these injected unconditional rules appear later in the
        //    document, they win the CSS cascade for equal specificity and restore the
        //    desktop light-mode appearance regardless of prefers-color-scheme.
        const lightModeStyle = `<style>
.node-item-type path{fill:#000}.node-item-type text{fill:#fff}
.node-item-function path{fill:#fff}.node-item-function text{fill:#000}
.node-item-type-layer path{fill:rgb(51,85,136)}
.node-item-type-activation path{fill:rgb(112,41,33)}
.node-item-type-pool path{fill:rgb(51,85,51)}
.node-item-type-normalization path{fill:rgb(51,85,68)}
.node-item-type-dropout path{fill:rgb(69,71,112)}
.node-item-type-shape path{fill:rgb(108,79,71)}
.node-item-type-tensor path{fill:rgb(89,66,59)}
.node-item-type-transform path{fill:rgb(51,85,68)}
.node-item-type-data path{fill:rgb(85,85,85)}
.node-item-type-quantization path{fill:rgb(80,40,0)}
.node-item-type-attention path{fill:rgb(120,60,0)}
.node-item-type-constant path{fill:#eee}.node-item-type-constant text{fill:#000}
.node-item-type-control path{fill:#eee}.node-item-type-control text{fill:#000}
.node path{stroke:#333}.node-argument-list>path{fill:#f2f2f2}
.edge-path{stroke:#333}.edge-label{fill:#222}
.node-argument>text{fill:#222}
.node-item-input path{fill:#fff}
.node-item-constant path{fill:#e6e6e6}
.graph-item-input path{fill:#f0f0f0}.graph-item-output path{fill:#f0f0f0}
</style>`;
        html = html.replace('</head>', lightModeStyle + '\n</head>');

        // 6. Replace <title>
        html = html.replace(/<title>Netron<\/title>/, `<title>${title}</title>`);

        return html;
    }
}
