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

        const bridgeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vscode-bridge.js')
        ).toString();

        const csp = [
            `default-src 'none'`,
            `script-src ${webview.cspSource}`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `img-src ${webview.cspSource} data: blob:`,
            `font-src ${webview.cspSource}`,
        ].join('; ');

        // Read Netron's index.html and do three targeted substitutions:
        //   1. Replace the CSP meta tag
        //   2. Replace the grapher.css link
        //   3. Replace the index.js script tag
        //   4. Inject the VS Code bridge before </body>
        const indexHtmlPath = path.join(netronSourceUri.fsPath, 'index.html');
        let html = fs.readFileSync(indexHtmlPath, 'utf8');

        html = html.replace(
            /<meta http-equiv="Content-Security-Policy"[^>]*>/,
            `<meta http-equiv="Content-Security-Policy" content="${csp}">`
        );
        html = html.replace(
            /href="grapher\.css"/,
            `href="${src('grapher.css')}"`
        );
        html = html.replace(
            /src="index\.js"/,
            `src="${src('index.js')}"`
        );
        html = html.replace(
            '</body>',
            `<script type="text/javascript" src="${bridgeUri}"></script>\n</body>`
        );

        // Replace <title>Netron</title> with the model filename
        html = html.replace(/<title>Netron<\/title>/, `<title>${title}</title>`);

        return html;
    }
}
