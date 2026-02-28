// vscode-bridge.js — runs inside the VS Code webview, after index.js.
//
// Execution order in <head>:
//   1. index.js  → defines window.exports (require/preload/terminate)
//                  attaches window 'load' listener (not yet fired)
//   2. this file → (A) overrides window.exports.require with correct base URL
//                  (B) wraps window.exports.preload to patch Host prototypes:
//                      - require(): fix relative import URL
//                      - worker(): blob URL workaround for cross-origin restriction
//                      - start(): signal 'ready' AFTER full initialization
//   3. 'load' fires → index.js handler calls window.exports.preload(callback)
//                  → our wrapper: modules load, prototypes patched,
//                     original callback creates Host + View + calls start()
//                     → our start() wrapper signals ready after start() resolves
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

    // --- B. Patch Host prototypes after modules load ------------------------
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
        // If start() is already done (view ready), open immediately.
        // Otherwise save as pendingMessage; start() wrapper will process it.
        if (window.__viewReady__) {
            openModel(msg);
        } else {
            pendingMessage = msg;
        }
    });

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

                // Fix timing: view.View.start() has three awaits BEFORE it sets
                // this._select (the TargetSelector). If we send 'ready' as soon as
                // window.__view__ exists (i.e. right after construction), the model
                // open call arrives while start() is still suspended and _select is
                // undefined → "Cannot read properties of undefined (reading 'update')".
                // Fix: wrap start() to signal ready only AFTER it fully resolves,
                // guaranteeing all internal state (_select, etc.) is initialized.
                var originalStart = window.exports.browser.Host.prototype.start;
                window.exports.browser.Host.prototype.start = async function () {
                    await originalStart.call(this);
                    window.__viewReady__ = true;
                    vscode.postMessage({ command: 'ready' });
                    if (pendingMessage) {
                        var msg = pendingMessage;
                        pendingMessage = null;
                        openModel(msg);
                    }
                };
            }
            callback(value, error);
        });
    };
}());
