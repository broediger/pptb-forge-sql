// Import only the core editor — avoids pulling in 40+ language
// contributions and all worker infrastructure.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

// Import only the languages we need
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';

export default monaco;
