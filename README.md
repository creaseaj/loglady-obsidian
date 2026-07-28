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

Then open the **LogLady panel** — the ribbon icon (terminal glyph), or the
command **LogLady: Open panel** — which opens a persistent pane in the left
sidebar, the same spirit as `loglady.html`'s catalog: it stays open while you
work, rather than a one-shot dialog. In the panel you can:

- drop or pick the `*_shell.log` (required) and `*_time.log` (optional,
  adds per-command timestamps and durations) files;
- search/filter the reconstructed commands — the session-ending `exit` and
  blank prompt lines are hidden by default;
- **drag a command straight onto an open note** to insert it there at the
  drop position (Obsidian's editor accepts the plain-text drop natively —
  nothing needs to be pre-selected first);
- or **click rows to bank them** (a running selection, like `loglady.html`'s
  catalog-to-bank model) and act on the whole batch with the footer buttons:
  - **Create notes** — one note per banked command (YAML frontmatter: title,
    session, cwd, timestamp, duration, an empty `tags` list) plus one index
    note per session listing `[[wikilinks]]` to its commands, written into
    the folder shown in the panel (defaults from Settings, editable per
    import);
  - **Insert at cursor** — drops every banked command as Markdown into the
    currently active note in one go.

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
- **Default notes folder** — pre-fills the panel's own Folder field; change it
  there per import without touching Settings each time.

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
builds the Markdown/YAML-frontmatter note bodies. `src/main.ts` registers the
view, the ribbon icon/command, and the settings tab. `src/view.ts` is the
panel itself: ingest, catalog rendering, drag-and-drop, the bank, and both
output actions.

## Notes on scope

Per-command Host/Severity/Status/Tags frontmatter (available in `loglady.html`'s
vault export) isn't in the panel yet — curate those afterward by editing a
created note's frontmatter directly in Obsidian, or use the browser tool's
richer authoring flow (multi-page book, per-command metadata fields, ANSI
colour preview) and its vault export instead. ANSI colour is not imported
either: Markdown has no portable colour form, so only the plain reconstructed
text is kept, matching `loglady.html`'s own Markdown/plain-HTML exports.
