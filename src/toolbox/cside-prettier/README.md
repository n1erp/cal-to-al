# C/Side Prettier

VS Code integration for NAV C/AL `.txt` syntax highlighting.

## Flow

1. User runs **C/Side Prettier** from the toolbox → `runCalPrettier()` opens a `.txt` file and sets `languageId` to `cside-nav`.
2. VS Code loads the TextMate grammar and language configuration from `grammar/` (see root `package.json`).

## Files

| File | Role |
| --- | --- |
| `index.ts` | `registerCsidePrettier` — wires the highlight command |
| `command.ts` | File picker and `cside-nav` language id assignment |
| `grammar/cside-nav.tmLanguage.json` | Syntax highlighting rules (TextMate scopes, `source.nav-cal`) |
| `grammar/language-configuration-cside.json` | Comments, brackets, auto-close, folding markers |
