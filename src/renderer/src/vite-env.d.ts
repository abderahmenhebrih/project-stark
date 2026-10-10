/// <reference types="vite/client" />

// Monaco language grammars register purely as a module side effect
// (Monarch tokenizers for every bundled language, plus the JSON
// language feature which has no basic-languages definition); the
// contribution entries ship no .d.ts, so they are declared ambiently
// here rather than weakened with inline ts-ignores at the import site.
declare module 'monaco-editor/basic-languages/monaco.contribution';
declare module 'monaco-editor/language/json/monaco.contribution';
