# LogLady (Obsidian plugin)

Import `script(1)` terminal session recordings — the shell typescript plus its
optional timing file — straight into Obsidian, as clean command/output pairs.

This is the companion importer to
[LogLady in mqor](https://github.com/creaseaj/mqor) (`loglady.html`), a
single-file browser tool that curates the same recordings into a multi-page
book and can export a ready-made Obsidian vault. This plugin covers the other
direction: skip the export/unzip round-trip and pull commands straight into
your already-open vault.

## What it does

Record a session with:

```
script --timing=time.log shell.log
```

Then, from Obsidian's command palette, run **LogLady: Import script(1)
session…**. A modal lets you:

- drop or pick the `*_shell.log` (required) and `*_time.log` (optional,
  adds per-command timestamps and durations) files;
- search/filter the reconstructed commands and tick the ones worth keeping —
  the session-ending `exit` and blank prompt lines are hidden by default;
- choose what happens to the selection:
  - **Create linked notes** — one note per command (with YAML frontmatter:
    title, session, cwd, timestamp, duration, an empty `tags` list) plus one
    index note per session listing `[[wikilinks]]` to its commands, written
    into a folder you choose;
  - **Insert at cursor** — drops the selected commands as Markdown
    (heading + meta line + fenced output) directly into the note you're
    currently editing.

The raw typescript is full of cursor-movement, tab-completion, and colour
escape codes — a small built-in terminal emulator replays it to reconstruct
just the clean visible text before anything is imported.

Notes created here use the same frontmatter shape as `loglady.html`'s
"Download Obsidian Vault" export, so a single Dataview query works across
notes regardless of which tool created them.

## Install (manual, until this is on the Community Plugins list)

1. Download `main.js`, `manifest.json`, and `styles.css` from this repo (or
   build them yourself — see below).
2. Copy them into `<your vault>/.obsidian/plugins/loglady/`.
3. Reload Obsidian (or toggle the plugin off/on), then enable **LogLady**
   under Settings → Community plugins.

## Settings

- **Command prompt regex** / **Working-directory regex** — the same
  configurable prompt-detection regexes as `loglady.html`'s Advanced section,
  for shells that don't use the default Kali-style two-line prompt.
- **Default notes folder** — where "Create linked notes" writes.
- **Default import mode** — which of the two destinations is pre-selected.

## Development

```
npm install
npm run dev      # esbuild watch mode, rebuilds main.js on change
npm run build    # type-check, then a minified production build
npm test          # runs the parsing-engine test suite (node:test)
```

`src/parser.ts` is the terminal-emulator/session-parsing engine, ported from
`loglady.html` and kept dependency-free and Obsidian-API-free on purpose — it
is unit-tested directly under Node (`tests/parser.test.mjs`) against a small
synthetic fixture in `tests/fixtures/`, independent of Obsidian. `src/notes.ts`
builds the Markdown/YAML-frontmatter note bodies. `src/main.ts` is the actual
plugin: the command, settings tab, and import modal.

## Notes on scope

Per-command Host/Severity/Status/Tags frontmatter (available in `loglady.html`'s
vault export) isn't in the import modal yet — curate those afterward by editing
a created note's frontmatter directly in Obsidian, or use the browser tool's
richer authoring flow (multi-page book, per-command metadata fields, ANSI
colour preview) and its vault export instead. ANSI colour is not imported
either: Markdown has no portable colour form, so only the plain reconstructed
text is kept, matching `loglady.html`'s own Markdown/plain-HTML exports.
