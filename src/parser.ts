/*
 * Terminal-session parsing engine. No DOM/Obsidian dependency, so it is
 * unit-testable under plain Node.
 *
 * Pipeline: parseSession() replays a script(1) typescript through
 * @xterm/headless (replay()) to reconstruct clean visible lines, then splits
 * the reconstructed lines into command/output pairs.
 *
 * Where a command begins is detected best-signal-first (see extractEntries):
 *   1. OSC 133 semantic prompt marks (A/B/C/D) — purpose-built, and carry the
 *      command's exit code;
 *   2. bracketed-paste toggles (DECSET 2004 h/l) — emitted by the line editor
 *      of every modern interactive shell, so they don't depend on prompt text;
 *   3. a prompt-matching regex — the fallback for shells that emit neither.
 * (1) and (2) both delimit the command *input* structurally, so the command
 * text is read straight off the reconstructed screen (redraws and history
 * edits already resolved) rather than scraped from prompt lines. replay()
 * records these as `marks`; the regex path works on `lines` alone.
 *
 * ANSI colour (SGR) is intentionally not tracked here — Markdown notes have no
 * portable colour form, so the plugin only needs plain reconstructed text.
 *
 * `byte` on ParsedLine/ParsedTitle/ShellMark is an *ordering* key, not a true
 * byte offset — it's the absolute row index in xterm.js's buffer at the
 * moment each was recorded. That's all extraction needs (everything below
 * only ever compares it with < / > / sort), and it comes for free from the
 * terminal's own state instead of hand-tracked byte bookkeeping. The
 * trade-off: it can't drive a byte-offset-to-elapsed-time mapping, so
 * per-command timestamps are not available in this engine.
 */

import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;

export interface ParsedLine {
  text: string;
  byte: number;
}

export interface ParsedTitle {
  /** The OSC numeric identifier (0/1/2/7 for titles, 133 is routed to marks instead). */
  code: number;
  text: string;
  byte: number;
}

/**
 * A shell-integration signal recovered during replay. `input`/`submit` bracket
 * the command line (submit carries the command text read off-screen at that
 * instant); `prompt` is OSC 133's prompt-start (a cleaner output cutoff than
 * `input`); `end` carries an OSC 133 exit code for the command just finished.
 */
export interface ShellMark {
  kind: "prompt" | "input" | "submit" | "end";
  byte: number;
  command?: string;
  /** On `input`: the prompt text left of the cursor, so the next command's
   *  prompt line can be trimmed off the prior output without a prompt regex. */
  prompt?: string;
  /** On `submit`: the row of the command's own line. Output is anchored to
   *  this, not to the submit row — a shell that emits the paste-off marker
   *  *after* the command's newline (smbclient, ftp, …) puts the first output
   *  line before the marker, and a submit-row window drops it. */
  line?: number;
  exit?: number | null;
}

export interface ReplayResult {
  lines: ParsedLine[];
  titles: ParsedTitle[];
  marks: ShellMark[];
}

export interface CommandEntry {
  command: string;
  cwd: string;
  byte: number;
  output: string;
  empty: boolean;
  noise: boolean;
  at: Date | null;
  dur: number | null;
  exit: number | null;
}

export interface ParsedSession {
  name: string;
  tty: string;
  term: string;
  cols: number;
  rows: number;
  started: string;
  done: string;
  exit: number | null;
  startEpoch: number | null;
  endEpoch: number | null;
  hasTiming: boolean;
  entries: CommandEntry[];
}

export const DEFAULT_PROMPT_RE = String.raw`└─[$#]\s?(.*)$`;
export const DEFAULT_CWD_RE = String.raw`┌──\(.*?\)-\[(.*?)\]`;

/** A terminal resize recovered from a script(1) advanced-format timing file. */
export interface Resize {
  byte: number; // body-byte offset (in the raw stream) at which the resize took effect
  cols: number;
  rows: number;
}

/**
 * A jump big enough that no realistic amount of scrollback (bounded by the
 * terminal's own `scrollback` option below) could ever grow into it. See
 * `replay()`'s `rowOffset` for what this guards against.
 */
const EPOCH_STEP = 100_000_000;

/* ---------------------------------------------------------------------------
 * Terminal emulator — replay a script(1) typescript body into clean lines,
 * via @xterm/headless. Operates on raw bytes so we can decode UTF-8 the same
 * way a real terminal would.
 * ------------------------------------------------------------------------- */
export async function replay(bytes: Uint8Array, colsIn: number, rowsIn: number, resizes: Resize[] = []): Promise<ReplayResult> {
  const cols = Math.max(20, colsIn | 0 || 80);
  const rows = Math.max(4, rowsIn | 0 || 24);
  const term = new Terminal({ cols, rows, scrollback: 200000, allowProposedApi: true });

  const titles: ParsedTitle[] = [];
  const marks: ShellMark[] = [];
  const preserved: ParsedLine[] = [];
  // Where the current command line began (cursor just past the prompt), set at
  // the input mark and read back at submit to lift the command off the screen.
  // inputRow is the exact, un-nudged row -- it's used as a real buffer index
  // via getLine(). inputByte is the ordering-key counterpart (see rowAt()),
  // carried into the input/submit marks' `byte`/`line` fields.
  let inputRow = -1, inputCol = 0, inputByte = -1;
  // The raw row at the most recent submit, so a same-row re-arm (see
  // armInput()) only snapshots what actually changed since then -- not the
  // whole viewport, which would drag in unrelated content sitting in rows
  // above that never got touched (a `--help` dump, e.g.) into every command
  // downstream of it.
  let lastSubmitRow = -1;

  // A full erase (`clear`'s ESC[H ESC[2J) or a full reset (RIS) doesn't scroll
  // anything into xterm.js's scrollback -- it just blanks the viewport in
  // place, discarding whatever was on screen and hadn't scrolled off yet. That
  // content is session history the same as anything already scrolled (on a
  // tall terminal most of a session can still be "on screen"), so it's
  // snapshotted into `preserved` before letting the erase happen (see
  // preserveViewport() below).
  //
  // Snapshotted rows reuse the same (baseY + cursorY) row numbers the *next*
  // screenful will also use, since erasing never advances scrollback. rowOffset
  // is bumped by a wide margin at each erase so every ordering key from then on
  // -- marks, titles, and the eventual live-buffer read at the end -- sorts
  // after everything from before it, without colliding with reused row numbers.
  // breakpoints lets the final scrollback read-out (which has no epoch of its
  // own) look up the right offset for a row by when it was actually written.
  let rowOffset = 0;
  const breakpoints: { atBaseY: number; rowOffset: number }[] = [{ atBaseY: 0, rowOffset: 0 }];

  const isNormal = (): boolean => term.buffer.active.type === "normal";
  const rawRowAt = (): number => rowOffset + term.buffer.active.baseY + term.buffer.active.cursorY;
  // The terminal's current row is not a unique ordinal on its own: repeated
  // CR-then-redraw-in-place edits (history/completion widgets, seen in real
  // captures) can revisit the exact same absolute row for multiple genuinely
  // distinct events with no scroll between them. Two submits landing on an
  // identical row collapsed into duplicate entries sharing one byte value,
  // each computing an ambiguous/overlapping output window. Nudge forward by
  // an epsilon whenever the raw row doesn't strictly advance, so every mark
  // still gets a unique, correctly-ordered key -- comparisons against a
  // line's plain integer row index are unaffected since the nudge never
  // reaches a whole row. This is for `byte`/ordering fields only -- never use
  // it as a buffer row index (getLine wants the exact, un-nudged row).
  let lastRowAt = -Infinity;
  const rowAt = (): number => {
    const raw = rawRowAt();
    const v = raw > lastRowAt ? raw : lastRowAt + 1e-6;
    lastRowAt = v;
    return v;
  };

  /**
   * Snapshot `count` rows starting at the current viewport's top (relative
   * rows 0..count-1) into `preserved`, then bump rowOffset so nothing written
   * afterward can collide with these now-stale row numbers. Shared by ED 2
   * (the whole non-blank viewport, about to be blanked in place by `clear`)
   * and an explicit CSI S scroll (just the rows about to scroll off the top,
   * which -- unlike a natural bottom-margin scroll -- xterm.js does not feed
   * to real scrollback).
   */
  function preserveRange(fromY: number, toY: number) {
    const buf = term.buffer.active;
    let cur: { text: string; byte: number } | null = null;
    for (let y = Math.max(0, fromY); y <= toY; y++) {
      const line = buf.getLine(buf.baseY + y);
      const text = line ? line.translateToString(false) : "";
      if (line && line.isWrapped && cur) cur.text += text;
      else { if (cur) { cur.text = cur.text.replace(/\s+$/, ""); preserved.push(cur); } cur = { text, byte: rowOffset + buf.baseY + y }; }
    }
    if (cur) { cur.text = cur.text.replace(/\s+$/, ""); preserved.push(cur); }
    rowOffset += EPOCH_STEP;
    breakpoints.push({ atBaseY: buf.baseY, rowOffset });
  }
  function preserveRows(count: number) { preserveRange(0, count - 1); }
  function preserveViewport() {
    const buf = term.buffer.active;
    let last = -1;
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (line && line.translateToString(true) !== "") last = y;
    }
    preserveRows(last + 1);
  }

  /**
   * The command as it stands on screen at submit: from the input position,
   * past the prompt, through the end of its (possibly wrapped) line.
   */
  function commandAtSubmit(): string {
    if (inputRow < 0) return "";
    const buf = term.buffer.active;
    const absRow = inputRow - rowOffset;
    const startLine = buf.getLine(absRow);
    if (!startLine) return "";
    let text = startLine.translateToString(false, Math.min(inputCol, term.cols));
    let y = absRow;
    while (true) {
      const nextLine = buf.getLine(y + 1);
      if (!nextLine || !nextLine.isWrapped) break;
      text += nextLine.translateToString(false);
      y++;
    }
    return text.replace(/\s+$/, "");
  }

  function armInput() {
    // If the row hasn't advanced since the last submit, a retry widget is
    // about to retype directly over whatever's on screen right now -- a
    // brief command output, a `^C` from an interrupted attempt -- with no
    // scroll to carry it into xterm.js's scrollback naturally. Only the
    // *final* state of each row survives to the end-of-replay buffer read,
    // so unlike a real terminal (where a human watching would have seen
    // it), that content is gone for good the instant it's overwritten
    // unless it's captured right now. Snapshot the span from just above the
    // cursor through a few rows below it -- a retry can jump the cursor back
    // up to the prompt row while real output it's about to clobber still
    // sits a row or two below it, so the cursor's own row alone isn't a wide
    // enough net. Both bounds are capped to a small margin around the
    // cursor, *not* lastSubmitRow itself: on a tall terminal, a lot of
    // ordinary scrolling can happen between the last real submit and this
    // one (this command's own output, e.g.) with no other event updating
    // lastSubmitRow in between, so it can be thousands of rows stale by the
    // time a same-row collision (checked against the *current* row via
    // lastRowAt, which every mark/title keeps fresh) actually happens --
    // an uncapped range would then sweep in the entire viewport, including
    // unrelated, already-frozen content sitting far above (a `--help` dump
    // the cursor jumps around inside of, e.g.) that was never part of what
    // any of these commands produced.
    const MARGIN = 4;
    const buf = term.buffer.active;
    const bufRow = buf.baseY + buf.cursorY; // xterm.js's own buffer index -- independent of rowOffset
    if (isNormal() && rowOffset + bufRow <= lastRowAt && lastSubmitRow >= 0) {
      // preserveRange() bumps rowOffset, so anything computed against the
      // *old* rowOffset before this point (raw row-at values) must not be
      // reused afterward -- bufRow itself is untouched by it, though.
      const cursorY = bufRow - buf.baseY;
      const fromY = Math.max(lastSubmitRow - buf.baseY, cursorY - MARGIN);
      const toY = Math.min(term.rows - 1, cursorY + MARGIN);
      preserveRange(fromY, toY);
    }
    inputRow = rowOffset + bufRow; inputCol = buf.cursorX;
    inputByte = rowAt();
    const line = buf.getLine(bufRow);
    marks.push({ kind: "input", byte: inputByte, prompt: line ? line.translateToString(false, 0, inputCol) : "" });
  }
  function fireSubmit() {
    const byte = rowAt();
    // Where output can safely start: normally the command's own text still
    // occupies the current row at submit, so output starts strictly after it
    // (`line: byte`, excluded by extraction's `>` comparison). But a shell
    // that emits its own newline before the paste-off marker (smbclient,
    // ftp, ...) already has the cursor at the start of a *fresh* row by
    // submit -- that row can already hold real output, so nudge `line` just
    // under it instead, or its first output line gets excluded too.
    //
    // This used to instead reach back to inputByte (the row where typing
    // began) to solve exactly the smbclient case, but that row goes stale
    // after a long in-place-redraw edit history (repeated CR-then-retype
    // with no scroll) and started sweeping unrelated earlier content into
    // the window -- anchoring on the submit itself needs no history at all.
    const buf = term.buffer.active;
    const line = buf.cursorX === 0 ? byte - 1e-7 : byte;
    marks.push({ kind: "submit", byte, command: commandAtSubmit(), line });
    // Pure buffer index (no rowOffset), valid for armInput()'s viewport-
    // relative preserveRange() call as long as nothing scrolls in between --
    // exactly the condition that call itself checks for.
    lastSubmitRow = buf.baseY + buf.cursorY;
    inputRow = -1; inputByte = -1;
  }

  const disposables: { dispose(): void }[] = [];
  for (const code of [0, 1, 2, 7]) {
    disposables.push(term.parser.registerOscHandler(code, (data) => {
      if (isNormal()) titles.push({ code, text: data, byte: rowAt() });
      return false; // don't consume -- let xterm.js's own OSC handling still run
    }));
  }
  disposables.push(term.parser.registerOscHandler(133, (data) => {
    if (!isNormal()) return false;
    const a = data.charAt(0);
    if (a === "A") marks.push({ kind: "prompt", byte: rowAt() });
    else if (a === "B") armInput();
    else if (a === "C") fireSubmit();
    else if (a === "D") {
      const m = data.match(/^D;(-?\d+)/);
      marks.push({ kind: "end", byte: rowAt(), exit: m ? parseInt(m[1], 10) : null });
    }
    return false;
  }));
  // Bracketed paste (DECSET 2004): the line editor turns it on when it starts
  // reading a command at the prompt, off the instant Enter submits.
  disposables.push(term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    const p0 = Array.isArray(params[0]) ? params[0][0] : params[0];
    if (isNormal() && p0 === 2004) armInput();
    return false; // don't consume -- xterm.js still needs to apply the mode itself
  }));
  disposables.push(term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    const p0 = Array.isArray(params[0]) ? params[0][0] : params[0];
    if (isNormal() && p0 === 2004 && inputRow >= 0) fireSubmit();
    return false;
  }));
  // ED (erase in display): mode 2 wipes the viewport in place -- preserve it
  // first (see preserveViewport()). Mode 3 (erase saved lines) is what `clear`
  // sends alongside 2 on modern terminfo; consumed outright (never reaches
  // xterm.js) so its real scrollback -- everything already committed via
  // natural scrolling -- is never touched. Partial erases (0/1, or the
  // no-param default) are ordinary redraw bookkeeping, left to xterm.js as-is.
  disposables.push(term.parser.registerCsiHandler({ final: "J" }, (params) => {
    const p0 = Array.isArray(params[0]) ? params[0][0] : params[0];
    if (p0 === 3) return true; // consumed: no-op, keep real scrollback intact
    if (p0 === 2 && isNormal()) preserveViewport();
    return false;
  }));
  // RIS (full reset, ESC c): same idea as ED 2 -- nothing scrolls, so capture
  // the viewport first.
  disposables.push(term.parser.registerEscHandler({ final: "c" }, () => {
    if (isNormal()) preserveViewport();
    return false;
  }));
  // CSI S (SU, explicit scroll-up): unlike a natural bottom-margin scroll
  // (a linefeed at the last row), xterm.js does not feed the rows this
  // scrolls off the top into real scrollback -- they're simply dropped. A
  // pager restoring its own view can send this; the rows about to go are
  // preserved the same way an ED 2/RIS erase is, before xterm.js scrolls them
  // away for good.
  disposables.push(term.parser.registerCsiHandler({ final: "S" }, (params) => {
    const p0 = Array.isArray(params[0]) ? params[0][0] : params[0];
    if (isNormal()) preserveRows(Math.max(1, p0 || 1));
    return false;
  }));

  const write = (chunk: Uint8Array): Promise<void> => new Promise(resolve => term.write(chunk, () => resolve()));

  const sorted = resizes.slice().sort((a, b) => a.byte - b.byte);
  let pos = 0;
  for (const r of sorted) {
    if (r.byte > pos) { await write(bytes.subarray(pos, r.byte)); pos = r.byte; }
    term.resize(Math.max(20, r.cols | 0 || cols), Math.max(4, r.rows | 0 || rows));
  }
  if (pos < bytes.length) await write(bytes.subarray(pos));

  for (const d of disposables) d.dispose();

  // Enumerate the final normal-buffer lines (never the alternate screen —
  // full-screen programs like vim/htop/less draw there and their frames are
  // not session history), oldest first, wrapped rows rejoined. Rows still
  // live at the end belong to whatever the last erase's offset was; rows
  // already in real scrollback predate it and use whichever offset was active
  // when they were actually written (found via `breakpoints`).
  const buf = term.buffer.normal;
  const offsetFor = (y: number): number => {
    if (y >= buf.baseY) return rowOffset; // still-live viewport row: the current epoch
    let o = 0;
    for (const b of breakpoints) { if (b.atBaseY <= y) o = b.rowOffset; else break; }
    return o;
  };
  const lines: ParsedLine[] = preserved.slice();
  let cur: { text: string; byte: number } | null = null;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(false);
    if (line.isWrapped && cur) cur.text += text;
    else { if (cur) { cur.text = cur.text.replace(/\s+$/, ""); lines.push(cur); } cur = { text, byte: offsetFor(y) + y }; }
  }
  if (cur) { cur.text = cur.text.replace(/\s+$/, ""); lines.push(cur); }
  lines.sort((a, b) => a.byte - b.byte);
  while (lines.length && lines[lines.length - 1].text === "") lines.pop();

  term.dispose();
  return { lines, titles, marks };
}

/** True for a util-linux "advanced" timing log (typed records) vs the classic
 *  "<delay> <bytes>" lines. */
function isAdvancedTiming(timeText: string): boolean {
  return /^[HIOS]\s/m.test(timeText);
}

/**
 * Timing file -> map body byte offset to elapsed seconds. Not currently wired
 * into parseSession (see the module comment on `byte`), kept for a future
 * engine that can recover real byte-accurate ordering.
 * Classic: "<delay> <bytes>". Advanced: "O <delay> <bytes>" for output, with
 * H/I/S records interleaved — only O bytes land in the output log, but every
 * record's delay is elapsed time, so non-output waits fold into the next O.
 */
export function buildTiming(timeText: string | null): ((offset: number) => number) | null {
  if (!timeText) return null;
  const advanced = isAdvancedTiming(timeText);
  const cumB = [0], cumT = [0];
  let b = 0, t = 0;
  for (const raw of timeText.split(/\r?\n/)) {
    if (advanced) {
      const m = raw.match(/^([HIOS])\s+([0-9]*\.?[0-9]+)(?:\s+([0-9]+))?/);
      if (!m) continue;
      t += parseFloat(m[2]);
      if (m[1] === "O" && m[3]) { b += parseInt(m[3], 10); cumT.push(t); cumB.push(b); }
    } else {
      const m = raw.match(/^\s*([0-9]*\.?[0-9]+)\s+([0-9]+)\s*$/);
      if (!m) continue;
      t += parseFloat(m[1]); b += parseInt(m[2], 10);
      cumT.push(t); cumB.push(b);
    }
  }
  if (cumB.length < 2) return null;
  return function elapsedAt(offset: number): number {
    let lo = 0, hi = cumB.length - 1;
    if (offset <= 0) return 0;
    if (offset >= cumB[hi]) return cumT[hi];
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cumB[mid] <= offset) lo = mid; else hi = mid - 1; }
    const b0 = cumB[lo], b1 = cumB[lo + 1] || b0, t0 = cumT[lo], t1 = cumT[lo + 1] || t0;
    const frac = b1 > b0 ? (offset - b0) / (b1 - b0) : 0;
    return t0 + frac * (t1 - t0);
  };
}

/**
 * Terminal resizes from an advanced-format timing log, as body-byte offsets.
 * `S <delay> SIGWINCH ROWS=<r> COLS=<c>` records sit between the O records, so
 * a resize's offset is the output bytes emitted before it — exactly where the
 * shell's SIGWINCH redraw begins in the reconstructed body. Classic logs carry
 * no resize information, so this is empty for them.
 */
export function parseResizes(timeText: string | null): Resize[] {
  if (!timeText || !isAdvancedTiming(timeText)) return [];
  const out: Resize[] = [];
  let b = 0;
  for (const raw of timeText.split(/\r?\n/)) {
    const o = raw.match(/^O\s+[0-9.]+\s+([0-9]+)/);
    if (o) { b += parseInt(o[1], 10); continue; }
    const s = raw.match(/^S\s+[0-9.]+\s+SIGWINCH\s+ROWS=([0-9]+)\s+COLS=([0-9]+)/);
    if (s) out.push({ byte: b, rows: parseInt(s[1], 10), cols: parseInt(s[2], 10) });
  }
  return out;
}

function parseWhen(s: string): number | null {
  if (!s) return null;
  const m = s.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}:?\d{2}|Z)?/);
  if (m) { const t = Date.parse(m[1] + "T" + m[2] + (m[3] ? m[3].replace(/(\d{2})(\d{2})$/, "$1:$2") : "")); if (!isNaN(t)) return t; }
  return null;
}

/* ---------------------------------------------------------------------------
 * Command extraction. extractEntries() is the dispatcher: it uses the shell
 * marks recovered during replay when the recording carries them (every modern
 * interactive shell), and falls back to the prompt regex otherwise.
 * ------------------------------------------------------------------------- */
export function extractEntries(lines: ParsedLine[], titles: ParsedTitle[], marks: ShellMark[], promptSrc?: string, cwdSrc?: string): CommandEntry[] {
  if (marks.some(m => m.kind === "submit")) return extractEntriesFromMarks(lines, titles, marks, cwdSrc);
  return extractEntriesByPrompt(lines, titles, promptSrc, cwdSrc);
}

/**
 * Marker-based extraction. `input`/`submit` (bracketed paste, or OSC 133 B/C)
 * bracket each command; the command text was lifted off the screen at submit,
 * so it needs no prompt stripping. Output is the reconstructed lines between a
 * submit and the next command's prompt/input, with the next prompt banner
 * trimmed off the tail (the regexes serve only that cleanup here, never the
 * boundary decision, so a prompt they don't match costs at most a stray
 * trailing line — never a missed or merged command).
 */
export function extractEntriesFromMarks(lines: ParsedLine[], titles: ParsedTitle[], marks: ShellMark[], cwdSrc?: string): CommandEntry[] {
  let cwdRe: RegExp | null;
  try { cwdRe = cwdSrc ? new RegExp(cwdSrc) : new RegExp(DEFAULT_CWD_RE); } catch { cwdRe = null; }
  const promptRe = new RegExp(DEFAULT_PROMPT_RE);

  interface Cmd { command: string; submitByte: number; lineByte: number; boundaryByte: number; promptPrefix: string; exit: number | null; }
  const cmds: Cmd[] = [];
  // The earliest boundary of the command currently being read — its OSC 133
  // prompt-start if present, else its input mark. Used as the *previous*
  // command's output cutoff so a prompt never bleeds into the prior output.
  let boundary: number | null = null, prompt = "";
  for (const m of marks) {
    if (m.kind === "prompt") { if (boundary == null) boundary = m.byte; }
    else if (m.kind === "input") { if (boundary == null) boundary = m.byte; prompt = m.prompt || ""; }
    else if (m.kind === "submit") {
      cmds.push({ command: (m.command || "").trim(), submitByte: m.byte, lineByte: m.line ?? m.byte, boundaryByte: boundary ?? m.byte, promptPrefix: prompt, exit: null });
      boundary = null; prompt = "";
    } else if (m.kind === "end") {
      if (cmds.length) cmds[cmds.length - 1].exit = m.exit ?? null;
    }
  }
  if (!cmds.length) return [];

  // A screen-scraped command can come out empty even though the shell really
  // ran something: a completion/history widget can blank the input row as
  // part of its redraw dance an instant before Enter, so there is nothing
  // left on screen to read at submit. Many shells (zsh's preexec hook, e.g.)
  // set the window title (OSC 2) to the literal command right as it starts —
  // when the on-screen text is empty, that title is the only surviving
  // record of what actually ran, so fall back to it rather than discarding
  // a real command as a noise (bare-Enter) entry.
  const titleCwdShape = /^[^\s@]+@[^\s@]+:\s?/;
  for (let k = 0; k < cmds.length; k++) {
    if (cmds[k].command !== "") continue;
    const hi = k + 1 < cmds.length ? cmds[k + 1].boundaryByte : Infinity;
    for (const t of titles) {
      if (t.byte <= cmds[k].submitByte || t.byte > hi) continue;
      if (t.code !== 2) continue;
      const body = t.text.trimEnd();
      if (body === "" || titleCwdShape.test(body)) continue;
      cmds[k].command = body;
      break;
    }
  }

  // Working directory over time, from OSC window titles ("user@host: <cwd>")
  // and two-line-prompt banners, looked up by byte at each command.
  const cwdEvents: { byte: number; cwd: string }[] = [];
  for (const t of titles) { const tm = t.text.match(/:\s*(.+)$/); if (tm) cwdEvents.push({ byte: t.byte, cwd: tm[1].trim() }); }
  if (cwdRe) for (const ln of lines) { const cm = ln.text.match(cwdRe); if (cm) cwdEvents.push({ byte: ln.byte, cwd: cm[1] }); }
  cwdEvents.sort((a, b) => a.byte - b.byte);
  const cwdAt = (byte: number): string => {
    let cwd = "";
    for (const e of cwdEvents) { if (e.byte <= byte) cwd = e.cwd; else break; }
    return cwd;
  };

  const entries: CommandEntry[] = [];
  for (let k = 0; k < cmds.length; k++) {
    const c = cmds[k];
    const endByte = k + 1 < cmds.length ? cmds[k + 1].boundaryByte : Infinity;
    // Start strictly after the command's own line (byte > lineByte), so the
    // first output line is kept even when the submit marker trails its newline.
    const outLines = lines.filter(ln => ln.byte > c.lineByte && ln.byte < endByte).map(ln => ln.text);
    while (outLines.length && outLines[0] === "") outLines.shift();
    // Drop the next command's prompt line where it trails this output. The
    // bracketed-paste boundary sits just after the prompt, so the prompt (and,
    // for a two-line prompt, its banner) lands here. The next command's own
    // captured prompt text matches it exactly — config-independent — with the
    // regexes covering only the extra banner row a shape like Kali's adds.
    const next = k + 1 < cmds.length ? cmds[k + 1] : null;
    const nextLine = next ? (next.promptPrefix + next.command).replace(/\s+$/, "") : "";
    const nextPrompt = next ? next.promptPrefix.replace(/\s+$/, "") : "";
    while (outLines.length) {
      const last = outLines[outLines.length - 1].replace(/\s+$/, "");
      const isNextPrompt = last !== "" && (last === nextLine || (nextPrompt !== "" && last === nextPrompt));
      if (last === "" || isNextPrompt || promptRe.test(last) || (cwdRe && cwdRe.test(last))) outLines.pop();
      else break;
    }
    const output = outLines.join("\n");
    const empty = output.trim() === "";
    // A submit with no command text is a bare Enter or a Ctrl-C at the prompt —
    // a boundary, not a command. Bracketed paste marks every such keypress, so
    // (unlike the regex path) these turn up routinely; hide them as noise.
    const noise = c.command === "" || /^exit(\s+\d+)?$/.test(c.command);
    entries.push({ command: c.command, cwd: cwdAt(c.submitByte), byte: c.submitByte, output, empty, noise, at: null, dur: null, exit: c.exit });
  }
  return entries;
}

/* ---------------------------------------------------------------------------
 * Regex fallback — split reconstructed lines into command/output pairs at
 * shell prompts, tracking the working directory from Kali-style two-line
 * prompts and/or OSC window-title updates. Used only when a recording carries
 * no shell-integration marks.
 * ------------------------------------------------------------------------- */
export function extractEntriesByPrompt(lines: ParsedLine[], titles: ParsedTitle[], promptSrc?: string, cwdSrc?: string): CommandEntry[] {
  let promptRe: RegExp, cwdRe: RegExp | null;
  try { promptRe = new RegExp(promptSrc || DEFAULT_PROMPT_RE); } catch { promptRe = new RegExp(DEFAULT_PROMPT_RE); }
  try { cwdRe = cwdSrc ? new RegExp(cwdSrc) : new RegExp(DEFAULT_CWD_RE); } catch { cwdRe = null; }

  const entries: (CommandEntry & { out: string[] })[] = [];
  let cur: (CommandEntry & { out: string[] }) | null = null;
  let pendingCwd: string | null = null, lastTitleCwd: string | null = null;
  let ti = 0;

  for (const ln of lines) {
    const text = ln.text;
    while (ti < titles.length && titles[ti].byte <= ln.byte) {
      const tm = titles[ti].text.match(/:\s*(.+)$/);
      if (tm) lastTitleCwd = tm[1].trim();
      ti++;
    }
    const cm = cwdRe ? text.match(cwdRe) : null;
    if (cm && !promptRe.test(text)) { pendingCwd = cm[1]; continue; }
    const pm = text.match(promptRe);
    if (pm) {
      if (cur) entries.push(cur);
      const cwd = pendingCwd || lastTitleCwd || "";
      cur = { command: pm[1].trim(), cwd, byte: ln.byte, out: [], output: "", empty: true, noise: false, at: null, dur: null, exit: null };
      pendingCwd = null;
      continue;
    }
    if (cur) cur.out.push(text);
  }
  if (cur) entries.push(cur);

  for (const e of entries) {
    const o = e.out.slice();
    while (o.length && o[0] === "") o.shift();
    while (o.length && o[o.length - 1] === "") o.pop();
    e.output = o.join("\n");
    e.empty = e.output.trim() === "";
    const cmd = e.command.trim();
    e.noise = (cmd === "" && e.empty) || /^exit(\s+\d+)?$/.test(cmd);
  }
  return entries.map(({ out, ...rest }) => rest);
}

/* ---------------------------------------------------------------------------
 * Full session parse: header -> replay -> entries.
 * ------------------------------------------------------------------------- */
const dec = new TextDecoder("utf-8");

function firstLine(bytes: Uint8Array): { text: string; end: number } {
  let nl = -1;
  for (let i = 0; i < bytes.length && i < 4096; i++) { if (bytes[i] === 0x0a) { nl = i; break; } }
  if (nl < 0) return { text: dec.decode(bytes.slice(0, Math.min(bytes.length, 4096))), end: bytes.length };
  return { text: dec.decode(bytes.slice(0, nl)), end: nl + 1 };
}

export async function parseSession(name: string, bytes: Uint8Array, timeText: string | null, promptSrc?: string, cwdSrc?: string, colsOverride?: number): Promise<ParsedSession> {
  const hdr = firstLine(bytes);
  const h = hdr.text;
  const started = (h.match(/Script started on\s+(.+?)\s*\[/) || [])[1] || "";
  // A recording's header COLUMNS is wrong when script captured a different size
  // than the shell wrapped at (e.g. script outside a narrower tmux pane), which
  // corrupts every wrapped redraw. An explicit override wins over the header.
  const cols = (colsOverride && colsOverride > 0) ? colsOverride : (parseInt((h.match(/COLUMNS="?(\d+)/) || [])[1] || "0", 10) || 80);
  const rows = parseInt((h.match(/LINES="?(\d+)/) || [])[1] || "0", 10) || 24;
  const tty = (h.match(/TTY="([^"]+)"/) || [])[1] || "";
  const term = (h.match(/TERM="([^"]+)"/) || [])[1] || "";

  let body = bytes.subarray(hdr.end);
  let done = "", exit: number | null = null;
  const tail = dec.decode(body.subarray(Math.max(0, body.length - 400)));
  const fm = tail.match(/\n?Script done on\s+(.+?)\s*\[COMMAND_EXIT_CODE="(-?\d+)"\][\s\S]*$/);
  if (fm) {
    done = fm[1]; exit = parseInt(fm[2], 10);
    const marker = "Script done on";
    const bodyStr = dec.decode(body);
    const p = bodyStr.lastIndexOf(marker);
    if (p >= 0) {
      let idx = new TextEncoder().encode(bodyStr.slice(0, p)).length;
      if (idx > 0 && body[idx - 1] === 0x0a) idx--;
      body = body.subarray(0, idx);
    }
  }

  const startEpoch = parseWhen(started);
  const endEpoch = parseWhen(done);
  const resizes = parseResizes(timeText);
  const { lines, titles, marks } = await replay(body, cols, rows, resizes);
  const entries = extractEntries(lines, titles, marks, promptSrc, cwdSrc);

  // No per-command timestamps in this engine: `byte` above is a row-ordering
  // key, not a real byte offset, so there's nothing to map through a timing
  // file (see the module comment). entries already carry at:null, dur:null.

  return { name, tty, term, cols, rows, started, done, exit, startEpoch, endEpoch, hasTiming: false, entries };
}
