import { loader } from '@monaco-editor/react';

// Use a selective import of the monaco-editor core + only the languages we
// need (SQL, XML). This avoids pulling in 40+ language contributions and all
// worker infrastructure, keeping the bundle well under 2 MB.
// PPTB's CSP blocks external scripts (cdn.jsdelivr.net), so we still load
// the editor locally — just a much leaner slice of it.
import monaco from './monacoEditorCore';

loader.config({ monaco });
