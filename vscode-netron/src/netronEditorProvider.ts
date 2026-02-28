import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class NetronEditorProvider implements vscode.CustomReadonlyEditorProvider {

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            'netron.modelView',
            new NetronEditorProvider(context),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        // Netron's source/ directory lives one level above this extension's directory
        const netronSourcePath = path.join(this.context.extensionPath, '..', 'source');
        const netronSourceUri = vscode.Uri.file(netronSourcePath);

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri, netronSourceUri],
        };

        webviewPanel.webview.html = this._buildHtml(
            webviewPanel.webview,
            netronSourceUri,
            path.basename(document.uri.fsPath)
        );

        // Wait for the webview to signal "ready", then send the file bytes
        const onMessage = webviewPanel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
            if (msg.command === 'ready') {
                onMessage.dispose();
                try {
                    const bytes = await vscode.workspace.fs.readFile(document.uri);
                    webviewPanel.webview.postMessage({
                        command: 'open',
                        name: path.basename(document.uri.fsPath),
                        data: bytes, // Uint8Array — transferred via structured clone
                    });
                } catch (err) {
                    vscode.window.showErrorMessage(`Netron: failed to read file – ${err}`);
                }
            }
        });
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
            `script-src ${webview.cspSource}`,
            `worker-src ${webview.cspSource}`,
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

        // 2. Inject netron-base meta tag so vscode-bridge.js can fix the module loader.
        //    Must come BEFORE index.js runs.
        html = html.replace(
            '<meta charset="utf-8">',
            `<meta charset="utf-8">\n<meta name="netron-base" content="${netronSourceWebviewUri}">`
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

        // 5. Replace <title>
        html = html.replace(/<title>Netron<\/title>/, `<title>${title}</title>`);

        return html;
    }
}
