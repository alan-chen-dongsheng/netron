// vscode-bridge.js — runs inside the VS Code webview
// Two responsibilities:
//  1. Fix Netron's module loader to use the correct webview resource base URL
//     (source/index.js derives the base from window.location.href which is
//      vscode-webview://... inside a webview — not a valid resource path).
//  2. Bridge VS Code extension host ↔ Netron: relay the model file bytes.
(function () {
    'use strict';

    // --- 1. Fix module loader ------------------------------------------------
    // The extension host injects a <meta name="netron-base"> with the
    // vscode-resource URI of the Netron source/ directory.
    var baseMeta = document.querySelector('meta[name="netron-base"]');
    var netronBase = baseMeta ? baseMeta.content.replace(/\/$/, '') + '/' : '';

    // Replace window.exports.require with a version that uses the correct base.
    // This runs synchronously before index.js's window.addEventListener('load')
    // fires, so we can safely override here.
    if (netronBase && window.exports && window.exports.require) {
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
    }

    // --- 2. Bridge extension host ↔ Netron ----------------------------------
    var vscode = acquireVsCodeApi(); // eslint-disable-line no-undef
    var pendingMessage = null;

    function openModel(msg) {
        var file = new File([msg.data], msg.name);
        window.__view__._host._open(file, [file]);
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
