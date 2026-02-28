# Netron – Copilot Instructions

## Build, Test & Lint

```bash
npm install          # install dependencies
npm start            # launch Electron desktop app
npm run server       # build and start web app (python package.py build start)
npm run lint         # ESLint (JS) + Ruff (Python)
npm test             # run all Playwright tests
npm test onnx        # run tests for a single format (replace 'onnx' with any format name)
npm run build        # production build
```

Web app debug shortcut: `python package.py build start --browse`
VS Code: press F5 to debug Electron; select "Desktop View" or "Browser" in the Debug tab.

## Architecture

Netron is a neural network model visualizer that runs as both an Electron desktop app and a browser web app. The same `source/` code powers both runtimes.

**Runtime entry points:**
- `source/app.js` – Electron main process
- `source/desktop.mjs` – Electron renderer bootstrap
- `source/browser.js` – browser entry point
- `source/server.py` – Python web server

**Core rendering pipeline:**
- `source/view.js` – central `View` class: loads models, manages UI state, orchestrates rendering
- `source/grapher.js` + `source/grapher.css` – graph layout and SVG rendering
- `source/node.js` – node/edge representation
- `source/worker.js` – off-main-thread model parsing

**Format parsers** (`source/{format}.js`): each format is self-contained and follows the same structure (see below). Supported formats include onnx, pytorch, tensorflow (tf), tflite, coreml, keras, caffe, caffe2, paddle, mxnet, rknn, and ~30 more.

**Schema/protocol layers:**
- `source/protobuf.js`, `source/flatbuffers.js` – binary schema decoders
- `source/{format}-proto.js` – generated protobuf bindings per format
- `source/{format}-schema.js` – generated flatbuffers bindings per format
- `source/{format}-metadata.json` – operator metadata (attributes, types, descriptions)

**Utilities:** `source/base.js` (primitives + native prototype extensions), `source/hdf5.js`, `source/pickle.js`, `source/zip.js`, `source/tar.js`, `source/numpy.js`, etc.

**Test infrastructure:**
- `test/browser.spec.js`, `test/desktop.spec.js` – Playwright tests
- `test/models.json` – registry of test models keyed by format
- `test/playwright.config.js` – two projects: `desktop` and `browser`; results in `dist/test-results/`

**Build/publish scripts:** `package.js` (Node), `package.py` (Python) – orchestrate clean, build, lint, test, publish, and version tasks.

## Key Conventions

**Module system:** ES6 modules throughout (`"type": "module"` in package.json). All `source/` files use `import`/`export`. Exception: `source/index.js` uses ES2015 script mode (no `import`).

**Format parser pattern:** Every format parser exports a single `ModelFactory` class assigned to a namespace object:
```js
import * as protobuf from './protobuf.js';
const onnx = {};
onnx.ModelFactory = class {
    async match(context) { ... }   // detect if file matches this format
    async open(context) { ... }    // parse and return model graph
};
export const ModelFactory = onnx.ModelFactory;
```
`match()` is called first; it sets a typed reader on `context`. `open()` builds the graph model. Multiple reader variants (e.g. `OrtReader`, `ProtoReader`, `TextReader`) are tried in sequence inside `match()`.

**Namespace pattern:** Each file defines a local namespace object (`const onnx = {}`) and attaches all classes to it. This avoids global pollution while keeping class references within the file readable.

**`no-await-in-loop` workaround:** ESLint enforces `no-await-in-loop`. When a loop `await` is unavoidable, wrap it with `/* eslint-disable no-await-in-loop */` / `/* eslint-enable no-await-in-loop */` comments.

**Indentation:** 4 spaces. Semicolons required. `prefer-const`, `prefer-template`, `object-shorthand` all enforced. `no-var` enforced everywhere except `source/index.js`.

**Private fields convention:** Instance fields are prefixed with `_` (e.g. `this._host`, `this._model`). There is no use of JS private class fields (`#`).

**Metadata files:** `source/{format}-metadata.json` stores operator attribute schemas. When adding or modifying operators for a format, update the corresponding metadata JSON.

**`tools/` directory:** Each subdirectory corresponds to a model format and contains scripts to download/convert test models and update schema files. Not part of the runtime bundle.
