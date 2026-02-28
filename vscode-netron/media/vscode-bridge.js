// vscode-bridge.js — runs inside the VS Code webview, after index.js.
//
// Execution order in <head>:
//   1. index.js  → defines window.exports (require/preload/terminate)
//                  attaches window 'load' listener (not yet fired)
//   2. this file → (A) overrides window.exports.require with correct base URL
//                  (B) wraps window.exports.preload to patch Host.prototype.worker
//                  (C) sets up VS Code message bridge
//   3. 'load' fires → index.js handler calls window.exports.preload(callback)
//                  -> our wrapper: modules load, worker URL is patched,
//                     then original callback creates Host + View correctly
(function () {
    'use strict';

    // Read the Netron source base URL from the <meta name="netron-base"> tag
    // injected by the extension host.
    var baseMeta = document.querySelector('meta[name="netron-base"]');
    var netronBase = baseMeta ? baseMeta.content.replace(/\/$/, '') + '/' : '';

    if (!netronBase) {
        console.error('vscode-bridge: netron-base meta tag not found');
        return;
    }

    // --- A. Fix window.exports.require --------------------------------------
    // index.js derives the script base URL from window.location.href, which is
    // "vscode-webview://..." in a webview, not a valid resource path.
    window.exports.require = function (id, callback) {
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
            throw new Error("Invalid module '" + id + "'.");
        }
        var url = netronBase + id + '.js';
        var scripts = document.head.getElementsByTagName('script');
        for (var i = 0; i < scripts.length; i++) {
            if (url === scripts[i].getAttribute('src')) {
                throw new Error("Duplicate import of '" + url + "'.");
            }
        }
        var script = document.createElement('script');
        script.setAttribute('id', id);
        script.setAttribute('type', 'module');
        var loadHandler = function () {
            script.removeEventListener('load', loadHandler);
            script.removeEventListener('error', errorHandler);
            callback();
        };
        var errorHandler = function (e) {
            script.removeEventListener('load', loadHandler);
            script.removeEventListener('error', errorHandler);
            callback(null, new Error("The script '" + e.target.src + "' failed to load."));
        };
        script.addEventListener('load', loadHandler, false);
        script.addEventListener('error', errorHandler, false);
        script.setAttribute('src', url);
        document.head.appendChild(script);
    };

    // --- B. Fix Web Worker URL ---------------------------------------------
    // browser.Host.worker() creates: new Worker('./worker.js', {type:'module'})
    // That relative path resolves against window.location.href
    // ("vscode-webview://...") and fails to load the worker script.
    // Even with a correct vscode-resource:// URL, browsers block Worker
    // construction across origins (vscode-webview:// vs file+.vscode-resource...).
    // Fix: wrap the real script URL in a blob: URL. Blob workers have no
    // cross-origin restriction, and relative imports inside worker.js still
    // resolve against the real script URL (ES module base URL semantics).
    var originalPreload = window.exports.preload;
    window.exports.preload = function (callback) {
        originalPreload(function (value, error) {
            if (!error && window.exports.browser && window.exports.browser.Host) {
                // Fix Host.require(): browser.Host.require(id) does import(`${id}.js`)
                // which resolves the relative URL against vscode-webview://... and fails.
                // All format parsers (onnx, pytorch, etc.) are loaded this way on demand,
                // so every model open would end with "Unsupported file content".
                window.exports.browser.Host.prototype.require = function (id) {
                    var url = netronBase + id.replace(/^\.\//, '') + '.js';
                    return import(url);
                };

                // Fix Host.worker(): blob URL workaround for cross-origin restriction.
                window.exports.browser.Host.prototype.worker = function (id) {
                    var workerUrl = netronBase + id.replace(/^\.\//, '') + '.js';
                    var blob = new Blob(
                        ['import ' + JSON.stringify(workerUrl) + ';'],
                        { type: 'application/javascript' }
                    );
                    return new this.window.Worker(URL.createObjectURL(blob), { type: 'module' });
                };
            }
            callback(value, error);
        });
    };

    // --- C. Bridge extension host <-> Netron --------------------------------
    var vscode = acquireVsCodeApi(); // eslint-disable-line no-undef
    var pendingMessage = null;

    function openModel(msg) {
        if (msg.url) {
            // URL-based loading: avoids Uint8Array→JSON→corruption in postMessage.
            // host._openModel() uses XHR to fetch from the vscode-resource URL
            // and then renders the graph, same as when the user drags a file in.
            window.__view__._host._openModel(msg.url, null, msg.name);
        } else if (msg.data) {
            // Fallback: binary transfer (kept for compatibility)
            var raw = msg.data;
            var data = (raw instanceof Uint8Array) ? raw : new Uint8Array(
                Array.isArray(raw) ? raw : Object.values(raw)
            );
            var file = new File([data], msg.name);
            window.__view__._host._open(file, [file]);
        }
    }

    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg || msg.command !== 'open') {
            return;
        }
        if (window.__view__) {
            openModel(msg);
        } else {
            pendingMessage = msg;
        }
    });

    var interval = setInterval(function () {
        if (!window.__view__) {
            return;
        }
        clearInterval(interval);
        vscode.postMessage({ command: 'ready' });
        if (pendingMessage) {
            openModel(pendingMessage);
            pendingMessage = null;
        }
    }, 50);
}());
