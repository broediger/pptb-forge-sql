import { loader } from '@monaco-editor/react';

// Use the locally bundled monaco-editor instead of loading from CDN.
// PPTB's CSP blocks external scripts (cdn.jsdelivr.net).
import * as monaco from 'monaco-editor';

loader.config({ monaco });

// Prevent Monaco from attempting to create Web Workers at all.
// PPTB's CSP (script-src 'self' 'unsafe-inline' pptb-webview:) blocks
// both blob: URLs and external worker scripts. By throwing immediately
// from getWorker, Monaco skips the Worker constructor and falls back
// to running language services on the main thread — which is fine for
// SQL and XML editing.
self.MonacoEnvironment = {
    getWorker: () => { throw new Error('No workers in PPTB iframe'); },
};
