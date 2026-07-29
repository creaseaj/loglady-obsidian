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
command **LogLady: Open panel** — a persistent pane in the left sidebar that
stays open while you work. In the panel you can:

- drop or pick the `*_shell.log` (required) and `*_time.log` (optional,
  adds per-command timestamps and durations) files;
- search/filter the reconstructed commands — the session-ending `exit` and
  blank prompt lines are hidden by default;
- **peek a command's response** — the ▸ button on a row expands the output
  that command produced (plus its working directory, duration, and exit code
  when known) right under it, without leaving the panel;
- **drag a command straight onto an open note** to insert it there at the
  drop position — the command as a Markdown block (heading, a meta line, and
  the captured output in a fenced block). Obsidian's editor accepts the
  plain-text drop natively, so nothing needs to be selected first.

The raw typescript is full of cursor-movement, tab-completion, and colour
escape codes — a small built-in terminal emulator replays it to reconstruct
just the clean visible text before anything is imported. Running `clear`
mid-session doesn't cost you the commands above it (they go to the emulator's
scrollback, the way a real terminal would), and full-screen programs like
`vim`, `less` or `htop` draw on the alternate screen, so their frames stay out
of the imported output.

## Install

### Community plugins (once listed)

Settings → Community plugins → Browse → search **LogLady** → Install, then
Enable. (Submission to the community list is pending — see
[PUBLISHING.md](PUBLISHING.md).)

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/creaseaj/loglady-obsidian/releases/latest)
   (they're release assets — the built `main.js` is not committed to the repo;
   you can also build it yourself, see below).
2. Copy them into `<your vault>/.obsidian/plugins/loglady/`.
3. Reload Obsidian (or toggle the plugin off/on), then enable **LogLady**
   under Settings → Community plugins.

Dragging a command onto a note needs a pointer, so the plugin is desktop-first.

## Settings

- **Command prompt regex** / **Working-directory regex** — the fallback
  prompt-detection regexes, for shells whose recordings carry no OSC 133 or
  bracketed-paste marks and don't use the default Kali-style two-line prompt.

## Development

```
npm install
npm run dev      # esbuild watch mode, rebuilds main.js on change
npm run build    # type-check, then a minified production build
npm test          # runs the parsing-engine test suite (node:test)
```

`src/parser.ts` is the terminal-emulator/session-parsing engine, kept
dependency-free and Obsidian-API-free on purpose — it is unit-tested directly
under Node (`tests/parser.test.mjs`) against a small synthetic fixture in
`tests/fixtures/`, independent of Obsidian.

Command boundaries are detected best-signal-first: OSC 133 semantic prompt
marks (unambiguous, and they carry each command's exit code) if the recording
has them, else bracketed-paste toggles (which every modern interactive shell
emits around the command line, so detection doesn't depend on prompt
appearance), else a prompt-matching regex as the fallback. The first two read
the command straight off the reconstructed screen, so redraws and in-place
history edits are already resolved. `tests/marks.test.mjs` covers all three.

Hand-rolling a VT emulator is a good way to hand-roll its bugs, so
`tests/differential.test.mjs` replays the same byte streams through
[xterm.js](https://xtermjs.org) (`@xterm/headless`) and asserts both engines
reconstruct identical text. xterm.js is a **dev dependency only** — it never
enters the shipped bundle, which keeps `main.js` small. Two divergences are
deliberate and asserted as such: a full screen erase (`clear`) and an explicit
scroll-up keep the lines a screen emulator discards, because this tool
reconstructs a session log rather than a screen. `src/notes.ts` builds the
Markdown block a dragged command drops into a note. `src/main.ts` registers the
view, the ribbon icon/command, and the settings tab. `src/view.ts` is the panel
itself: ingest, catalog rendering, output peeking, and drag-and-drop.

## Notes on scope

The panel imports commands one at a time by drag. It doesn't create notes or
write frontmatter — drop a command into whatever note you like and shape it
there. ANSI colour is not imported: Markdown has no portable colour form, so
only the plain reconstructed text is kept.
