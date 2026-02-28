// vscode-bridge.js — runs inside the VS Code webview
// Bridges VS Code's extension host ↔ Netron's browser runtime.
(function () {
    'use strict';

    // acquireVsCodeApi() is injected by VS Code into the webview context.
    const vscode = acquireVsCodeApi(); // eslint-disable-line no-undef

    let pendingMessage = null;

    // Open a model using Netron's internal host API.
    function openModel(msg) {
        // msg.data is a Uint8Array transferred via structured clone from the extension.
        const file = new File([msg.data], msg.name);
        // window.__view__ is set by Netron's index.js bootstrap.
        // _host._open(file, files) is the internal entry point used by drag-and-drop.
        window.__view__._host._open(file, [file]);
    }

    // Listen for messages from the extension host.
    window.addEventListener('message', function (event) {
        const msg = event.data;
        if (!msg || msg.command !== 'open') {
            return;
        }
        if (window.__view__) {
            openModel(msg);
        } else {
            // Netron not yet initialised — hold the message until ready.
            pendingMessage = msg;
        }
    });

    // Poll until Netron's view is initialised, then signal the extension host.
    const CHECK_INTERVAL_MS = 50;
    const interval = setInterval(function () {
        if (!window.__view__) {
            return;
        }
        clearInterval(interval);

        // Tell the extension we're ready to receive the file.
        vscode.postMessage({ command: 'ready' });

        // Flush any message that arrived before initialisation finished.
        if (pendingMessage) {
            openModel(pendingMessage);
            pendingMessage = null;
        }
    }, CHECK_INTERVAL_MS);
}());
