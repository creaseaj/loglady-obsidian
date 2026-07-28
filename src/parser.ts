/*
 * Terminal-session parsing engine. Pure data transforms, no DOM/Obsidian
 * dependency, so it is unit-testable under plain Node.
 *
 * Pipeline: parseSession() replays a script(1) typescript through a small VT
 * emulator (replay()) to reconstruct clean visible lines, maps each line to an
 * elapsed-time offset via the paired timing file (buildTiming()), then splits
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
 */

export interface ParsedLine {
  text: string;
  byte: number;
}

export interface ParsedTitle {
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

/** DEC special graphics, ASCII 0x5f-0x7e in order — the VT100 box-drawing set. */
const DEC_GRAPHICS = [
  " ", "◆", "▒", "␉", "␌", "␍", "␊", "°", "±", "␤", "␋", "┘", "┐", "┌", "└", "┼",
  "⎺", "⎻", "─", "⎼", "⎽", "├", "┤", "┴", "┬", "│", "≤", "≥", "π", "≠", "£", "·",
];

export const DEFAULT_PROMPT_RE = String.raw`└─[$#]\s?(.*)$`;
export const DEFAULT_CWD_RE = String.raw`┌──\(.*?\)-\[(.*?)\]`;

/* ---------------------------------------------------------------------------
 * Terminal emulator — replay a script(1) typescript body into clean lines.
 * Operates on raw bytes so we can (a) decode UTF-8 and (b) map each output
 * line back to a byte offset for timestamping via the timing file.
 * ------------------------------------------------------------------------- */
export function replay(bytes: Uint8Array, colsIn: number, rowsIn: number): ReplayResult {
  const cols = Math.max(20, colsIn | 0 || 80);
  const rows = Math.max(4, rowsIn | 0 || 24);
  const blank = (): string[] => Array(cols).fill(" ");
  let grid: string[][] = Array.from({ length: rows }, blank);
  let wrap: boolean[] = Array(rows).fill(false);
  let rowByte: number[] = Array(rows).fill(0);
  let cx = 0, cy = 0, pendingWrap = false;
  const out: { row: string[]; wrapped: boolean; byte: number }[] = [];
  const titles: ParsedTitle[] = [];
  const marks: ShellMark[] = [];
  // Where the current command line began (cursor just past the prompt), set at
  // the input mark and read back at submit to lift the command off the screen.
  let inputRow = -1, inputCol = 0;

  let pos = 0;
  // Alternate screen buffer (DECSET 1049/1047/47): full-screen programs draw
  // there and restore the shell's screen on exit. Nothing drawn while it is
  // active belongs in the session history, so commits are dropped until the
  // program leaves it.
  let inAlt = false;
  let savedScreen: { grid: string[][]; wrap: boolean[]; rowByte: number[]; cx: number; cy: number; top: number; bot: number } | null = null;
  // Scroll region (DECSTBM) margins, and the DECSC/DECRC cursor save slot.
  let top = 0, bot = rows - 1;
  let savedCursor: { cx: number; cy: number } | null = null;
  let insertMode = false; // IRM (CSI 4h): typed cells shift the rest of the row right
  let autowrap = true;    // DECAWM (CSI ?7l off): writes past the last column overwrite it
  let g0Graphics = false; // ESC ( 0: DEC special graphics designated into G0
  let lastPrinted = -1;   // for REP (CSI b)

  function commit(row: string[], wrapped: boolean, byte: number) {
    if (inAlt) return;
    out.push({ row, wrapped, byte });
  }
  /**
   * Push the visible screen into history, trailing blank rows dropped.
   *
   * A full erase — what `clear` sends as ESC[H ESC[2J ESC[3J — would otherwise
   * destroy every line that hasn't scrolled off yet, silently dropping the most
   * recent commands from the reconstruction. A real terminal moves them to
   * scrollback; `out` is our scrollback, so they go there before the blanking.
   *
   * A program that erases and then redraws the same screen in the *primary*
   * buffer will duplicate those lines here. That is rare outside full-screen
   * apps, and those live on the alternate screen, where commit() drops them.
   */
  function commitScreen() {
    let last = -1;
    for (let y = 0; y < rows; y++) if (grid[y].join("").trim() !== "") last = y;
    for (let y = 0; y <= last; y++) commit(grid[y], wrap[y], rowByte[y]);
  }
  function clearScreen() {
    for (let y = 0; y < rows; y++) { grid[y] = blank(); wrap[y] = false; rowByte[y] = pos; }
    pendingWrap = false;
  }
  function enterAlt() {
    if (inAlt) return;
    savedScreen = { grid, wrap, rowByte, cx, cy, top, bot };
    grid = Array.from({ length: rows }, blank);
    wrap = Array(rows).fill(false);
    rowByte = Array(rows).fill(pos);
    cx = 0; cy = 0; pendingWrap = false;
    top = 0; bot = rows - 1;
    inAlt = true;
  }
  function leaveAlt() {
    if (!inAlt || !savedScreen) return;
    ({ grid, wrap, rowByte, cx, cy, top, bot } = savedScreen);
    savedScreen = null; inAlt = false; pendingWrap = false;
  }
  /**
   * Scroll the margin region up, the way a line feed at the bottom margin does.
   * Only a full-screen scroll feeds history: when a program has set a smaller
   * region it is animating a viewport (a pager's text area), and those rows are
   * frames, not session output — the same reason alternate-screen writes never
   * reach `out`.
   */
  function scrollRegionUp(k = 1) {
    for (let i = 0; i < k; i++) {
      if (top === 0 && bot === rows - 1) commit(grid[top], wrap[top], rowByte[top]);
      grid.splice(top, 1); grid.splice(bot, 0, blank());
      wrap.splice(top, 1); wrap.splice(bot, 0, false);
      rowByte.splice(top, 1); rowByte.splice(bot, 0, pos);
    }
  }
  function scrollRegionDown(k = 1) {
    for (let i = 0; i < k; i++) {
      grid.splice(bot, 1); grid.splice(top, 0, blank());
      wrap.splice(bot, 1); wrap.splice(top, 0, false);
      rowByte.splice(bot, 1); rowByte.splice(top, 0, pos);
    }
  }
  function lf() {
    if (cy === bot) scrollRegionUp(1);
    else if (cy < rows - 1) cy++;
    rowByte[cy] = pos;
  }
  /** Reverse index (ESC M): up a line, scrolling the region down at the top margin. */
  function ri() {
    if (cy === top) scrollRegionDown(1);
    else if (cy > 0) cy--;
  }
  function moveCancelsWrap() { pendingWrap = false; }
  /**
   * Break the continuation link *into* row y — `wrap[y-1]` says row y-1 flows
   * into row y, which is xterm's `isWrapped` flag living on row y itself.
   * Erasing or displacing row y invalidates it. Missing this glued a shell's
   * command line onto the prompt banner redrawn beneath it, and swallowed the
   * banner line the working-directory regex reads.
   */
  function breakIncoming(y: number) { if (y > 0) wrap[y - 1] = false; }
  /**
   * The command text as it stands on screen right now, from a start position
   * just past the prompt through the end of its (possibly wrapped) line. Read
   * at submit time, so cursor motion, redraws, and history-recall edits are
   * already resolved into the final visible characters.
   */
  function commandTextFrom(sy: number, sx: number): string {
    if (sy < 0 || sy >= rows) return "";
    const parts = [grid[sy].slice(Math.min(sx, cols)).join("")];
    let y = sy;
    while (y < rows - 1 && wrap[y]) { y++; parts.push(grid[y].join("")); }
    return parts.join("").replace(/\s+$/, "");
  }
  /** Route an OSC string to a shell mark (OSC 133) or the window-title list. */
  function handleOsc(s: string, byte: number) {
    if (s.startsWith("133;")) {
      const a = s.charAt(4);
      if (a === "A") marks.push({ kind: "prompt", byte });
      else if (a === "B") { inputRow = cy; inputCol = cx; marks.push({ kind: "input", byte, prompt: grid[cy].slice(0, cx).join("") }); }
      else if (a === "C") marks.push({ kind: "submit", byte, command: commandTextFrom(inputRow, inputCol) });
      else if (a === "D") { const m = s.match(/^133;D;(-?\d+)/); marks.push({ kind: "end", byte, exit: m ? parseInt(m[1], 10) : null }); }
      return;
    }
    titles.push({ text: s, byte });
  }
  function put(cp: number) {
    if (pendingWrap) { wrap[cy] = true; cx = 0; lf(); pendingWrap = false; }
    if (insertMode) for (let x = cols - 1; x > cx; x--) grid[cy][x] = grid[cy][x - 1];
    // With DEC special graphics designated (ESC ( 0), ASCII in 0x5f-0x7e maps
    // to the box-drawing set — the difference between "lqqqk" and "┌───┐".
    const ch = g0Graphics && cp >= 0x5f && cp <= 0x7e ? DEC_GRAPHICS[cp - 0x5f] : String.fromCodePoint(cp);
    grid[cy][cx] = ch; cx++;
    lastPrinted = cp;
    if (cx >= cols) { cx = cols - 1; pendingWrap = autowrap; }
  }

  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    pos = i;
    if (b === 0x1b) { // ESC
      const nx = bytes[i + 1];
      if (nx === 0x5b) { // CSI '['
        moveCancelsWrap();
        // Parameter bytes are 0x30-0x3f (digits, ';', ':', '?', '<', '=', '>')
        // and intermediates 0x20-0x2f, per ECMA-48. Stopping early on either
        // used to leave the sequence's final letter behind as literal text --
        // `ESC[2 q`, the cursor-shape setter shells emit on every prompt,
        // deposited a stray "q", and colon-form SGR (ESC[38:2::255:0:0m) spilled
        // its whole colour spec into the reconstruction.
        let j = i + 2, params = "", inter = "";
        while (j < n && bytes[j] >= 0x30 && bytes[j] <= 0x3f) { params += String.fromCharCode(bytes[j]); j++; }
        while (j < n && bytes[j] >= 0x20 && bytes[j] <= 0x2f) { inter += String.fromCharCode(bytes[j]); j++; }
        const fin = inter ? -1 : bytes[j]; // an intermediate means a sequence we don't act on
        const priv = params.charAt(0) === "?";
        const ps = (priv ? params.slice(1) : params)
          .split(";")
          .map(s => s.split(":")[0]) // colon sub-parameters: the leading value is the one we'd use
          .map(s => (s === "" ? 0 : parseInt(s, 10)));
        const p0 = ps[0] || 0;
        switch (fin) {
          case 0x41: cy = Math.max(0, cy - (p0 || 1)); break; // A up
          case 0x42: cy = Math.min(rows - 1, cy + (p0 || 1)); break; // B down
          case 0x43: cx = Math.min(cols - 1, cx + (p0 || 1)); break; // C right
          case 0x44: cx = Math.max(0, cx - (p0 || 1)); break; // D left
          case 0x45: cx = 0; cy = Math.min(rows - 1, cy + (p0 || 1)); break; // E
          case 0x46: cx = 0; cy = Math.max(0, cy - (p0 || 1)); break; // F
          case 0x47: case 0x60: cx = Math.max(0, Math.min(cols - 1, (p0 || 1) - 1)); break; // G/` column absolute
          case 0x61: cx = Math.min(cols - 1, cx + (p0 || 1)); break; // a column relative
          case 0x65: cy = Math.min(rows - 1, cy + (p0 || 1)); break; // e row relative
          case 0x62: { const k = p0 || 1; for (let r = 0; r < k && lastPrinted >= 0; r++) put(lastPrinted); break; } // b repeat
          case 0x64: cy = Math.max(0, Math.min(rows - 1, (p0 || 1) - 1)); break; // d row
          case 0x48: case 0x66: // H/f pos
            cy = Math.max(0, Math.min(rows - 1, (ps[0] || 1) - 1));
            cx = Math.max(0, Math.min(cols - 1, (ps[1] || 1) - 1));
            break;
          case 0x4a: { // J erase display
            const m = p0;
            // Partial erases (0/1) are prompt and redraw bookkeeping around
            // content that is still on screen — committing there would double
            // lines up, so only the full erase flushes to history.
            if (m === 0) {
              for (let x = cx; x < cols; x++) grid[cy][x] = " ";
              wrap[cy] = false;
              if (cx === 0) breakIncoming(cy);
              for (let y = cy + 1; y < rows; y++) { grid[y] = blank(); wrap[y] = false; }
            } else if (m === 1) {
              for (let x = 0; x <= cx; x++) grid[cy][x] = " ";
              breakIncoming(cy);
              for (let y = 0; y < cy; y++) { grid[y] = blank(); wrap[y] = false; }
            }
            else if (m === 3) { /* erase saved lines: `out` is that scrollback, and it is the whole point here — keep it */ }
            else { commitScreen(); clearScreen(); }
            break;
          }
          case 0x68: case 0x6c: { // h/l set/reset mode
            const set = fin === 0x68;
            if (priv && (p0 === 1049 || p0 === 1047 || p0 === 47)) { if (set) enterAlt(); else leaveAlt(); }
            else if (priv && p0 === 7) autowrap = set; // DECAWM
            else if (priv && p0 === 2004) {
              // Bracketed paste: the line editor turns it on when it starts
              // reading a command at the prompt, off the instant Enter submits.
              if (set) { inputRow = cy; inputCol = cx; marks.push({ kind: "input", byte: pos, prompt: grid[cy].slice(0, cx).join("") }); }
              else if (inputRow >= 0) { marks.push({ kind: "submit", byte: pos, command: commandTextFrom(inputRow, inputCol) }); inputRow = -1; }
            }
            else if (!priv && p0 === 4) insertMode = set; // IRM
            break;
          }
          case 0x4b: { // K erase line
            const m = p0;
            if (m === 0) { for (let x = cx; x < cols; x++) grid[cy][x] = " "; wrap[cy] = false; if (cx === 0) breakIncoming(cy); }
            else if (m === 1) { for (let x = 0; x <= cx; x++) grid[cy][x] = " "; breakIncoming(cy); }
            else { grid[cy] = blank(); wrap[cy] = false; breakIncoming(cy); }
            break;
          }
          case 0x40: { const k = p0 || 1; for (let x = cols - 1; x >= cx + k; x--) grid[cy][x] = grid[cy][x - k]; for (let x = cx; x < cx + k && x < cols; x++) grid[cy][x] = " "; break; } // @ insert
          case 0x50: { const k = p0 || 1; for (let x = cx; x < cols; x++) grid[cy][x] = (x + k < cols) ? grid[cy][x + k] : " "; break; } // P delete
          case 0x58: { const k = p0 || 1; for (let x = cx; x < cx + k && x < cols; x++) grid[cy][x] = " "; break; } // X erase chars
          case 0x4c: { // L insert lines
            if (cy < top || cy > bot) break;
            const k = Math.min(p0 || 1, bot - cy + 1);
            for (let i2 = 0; i2 < k; i2++) {
              grid.splice(bot, 1); grid.splice(cy, 0, blank());
              wrap.splice(bot, 1); wrap.splice(cy, 0, false);
              rowByte.splice(bot, 1); rowByte.splice(cy, 0, pos);
            }
            breakIncoming(cy); cx = 0; break;
          }
          case 0x4d: { // M delete lines
            if (cy < top || cy > bot) break;
            const k = Math.min(p0 || 1, bot - cy + 1);
            for (let i2 = 0; i2 < k; i2++) {
              grid.splice(cy, 1); grid.splice(bot, 0, blank());
              wrap.splice(cy, 1); wrap.splice(bot, 0, false);
              rowByte.splice(cy, 1); rowByte.splice(bot, 0, pos);
            }
            breakIncoming(cy); cx = 0; break;
          }
          case 0x53: scrollRegionUp(p0 || 1); break; // S scroll up
          case 0x54: scrollRegionDown(p0 || 1); break; // T scroll down
          case 0x72: { // r set scrolling region (DECSTBM)
            if (priv) break; // ?r is a private-mode restore, not a margin set
            const t = (ps[0] || 1) - 1, b = (ps[1] || rows) - 1;
            if (t >= 0 && t < b && b < rows) { top = t; bot = b; cx = 0; cy = top; }
            break;
          }
          default: break; // m (SGR) etc: ignore — no colour tracking here
        }
        i = j + 1; continue;
      } else if (nx === 0x50 || nx === 0x5f || nx === 0x5e || nx === 0x58) {
        // DCS / APC / PM / SOS: string sequences whose payload is for the
        // terminal, never for display (tmux passthrough, kitty graphics,
        // status strings). Skipping only the two-byte introducer printed the
        // whole payload as text. Consume to the string terminator.
        let j = i + 2;
        const cap = Math.min(n, i + 65536);
        while (j < cap && bytes[j] !== 0x07 && !(bytes[j] === 0x1b && bytes[j + 1] === 0x5c)) j++;
        if (bytes[j] === 0x07) i = j + 1;
        else if (bytes[j] === 0x1b) i = j + 2;
        else i += 2; // unterminated: fall back to treating it as a stray escape
        continue;
      } else if (nx === 0x63) { // c RIS full reset
        commitScreen();
        clearScreen();
        cx = 0; cy = 0; top = 0; bot = rows - 1;
        insertMode = false; autowrap = true; g0Graphics = false; savedCursor = null;
        i += 2; continue;
      } else if (nx === 0x5d) { // OSC ']'
        // Bounded scan: an ESC ] that never terminates (a stray escape in
        // binary output, say) used to swallow the entire rest of the file.
        // A real OSC string carries no newline, so one ends the scan.
        let j = i + 2, s = "";
        const cap = Math.min(n, i + 4096);
        while (j < cap && bytes[j] !== 0x07 && bytes[j] !== 0x0a && bytes[j] !== 0x0d && !(bytes[j] === 0x1b && bytes[j + 1] === 0x5c)) { s += String.fromCharCode(bytes[j]); j++; }
        if (bytes[j] === 0x07) { handleOsc(s, i); i = j + 1; }
        else if (bytes[j] === 0x1b && bytes[j + 1] === 0x5c) { handleOsc(s, i); i = j + 2; }
        else i += 2; // unterminated: treat as a stray escape and keep parsing
        continue;
      } else if (nx === 0x37) { savedCursor = { cx, cy }; i += 2; continue; } // 7 DECSC save cursor
      else if (nx === 0x38) { if (savedCursor) ({ cx, cy } = savedCursor); pendingWrap = false; i += 2; continue; } // 8 DECRC restore
      else if (nx === 0x44) { lf(); pendingWrap = false; i += 2; continue; } // D index
      else if (nx === 0x45) { cx = 0; lf(); pendingWrap = false; i += 2; continue; } // E next line
      else if (nx === 0x4d) { ri(); pendingWrap = false; i += 2; continue; } // M reverse index
      else if (nx === 0x3d || nx === 0x3e) { i += 2; continue; } // = > keypad modes
      else if (nx === 0x28 || nx === 0x29 || nx === 0x2a || nx === 0x2b) { // charset ( ) * +
        if (nx === 0x28) g0Graphics = bytes[i + 2] === 0x30; // ESC ( 0 selects DEC special graphics
        i += 3; continue;
      }
      else { i += 2; continue; }
    }
    if (b === 0x0d) { cx = 0; moveCancelsWrap(); i++; continue; } // CR
    if (b === 0x0a) { lf(); moveCancelsWrap(); i++; continue; } // LF
    if (b === 0x08) { cx = Math.max(0, cx - 1); moveCancelsWrap(); i++; continue; } // BS
    if (b === 0x09) { cx = Math.min(cols - 1, (Math.floor(cx / 8) + 1) * 8); moveCancelsWrap(); i++; continue; } // TAB
    if (b < 0x20) { i++; continue; } // other C0
    // UTF-8 decode
    let cp = b, len = 1;
    if (b >= 0xf0) { cp = b & 0x07; len = 4; } else if (b >= 0xe0) { cp = b & 0x0f; len = 3; } else if (b >= 0xc0) { cp = b & 0x1f; len = 2; }
    for (let k = 1; k < len; k++) { const c = bytes[i + k]; if (c === undefined || (c & 0xc0) !== 0x80) { len = 1; cp = b; break; } cp = (cp << 6) | (c & 0x3f); }
    if (len > 1 && cp < 0x20) { cp = 0xFFFD; }
    put(cp); i += len;
  }
  if (inAlt) leaveAlt(); // session ended inside a full-screen program
  for (let y = 0; y < rows; y++) commit(grid[y], wrap[y], rowByte[y]);

  const lines: ParsedLine[] = [];
  let cur: { text: string; byte: number } | null = null;
  for (const c of out) {
    const text = c.row.join("");
    if (cur) { cur.text += text; }
    else cur = { text, byte: c.byte };
    if (!c.wrapped) { cur.text = cur.text.replace(/\s+$/, ""); lines.push(cur); cur = null; }
  }
  if (cur) { (cur as any).text = (cur as any).text.replace(/\s+$/, ""); lines.push(cur as ParsedLine); }
  while (lines.length && lines[lines.length - 1].text === "") lines.pop();
  return { lines, titles, marks };
}

/* ---------------------------------------------------------------------------
 * Timing file -> map body byte offset to elapsed seconds.
 * Each line: "<delay> <bytes>". Bytes accumulate over the replayed body.
 * ------------------------------------------------------------------------- */
export function buildTiming(timeText: string | null): ((offset: number) => number) | null {
  if (!timeText) return null;
  const cumB = [0], cumT = [0];
  let b = 0, t = 0;
  for (const raw of timeText.split(/\r?\n/)) {
    const m = raw.match(/^\s*([0-9]*\.?[0-9]+)\s+([0-9]+)\s*$/);
    if (!m) continue;
    t += parseFloat(m[1]); b += parseInt(m[2], 10);
    cumT.push(t); cumB.push(b);
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

  interface Cmd { command: string; submitByte: number; boundaryByte: number; promptPrefix: string; exit: number | null; }
  const cmds: Cmd[] = [];
  // The earliest boundary of the command currently being read — its OSC 133
  // prompt-start if present, else its input mark. Used as the *previous*
  // command's output cutoff so a prompt never bleeds into the prior output.
  let boundary: number | null = null, prompt = "";
  for (const m of marks) {
    if (m.kind === "prompt") { if (boundary == null) boundary = m.byte; }
    else if (m.kind === "input") { if (boundary == null) boundary = m.byte; prompt = m.prompt || ""; }
    else if (m.kind === "submit") {
      cmds.push({ command: (m.command || "").trim(), submitByte: m.byte, boundaryByte: boundary ?? m.byte, promptPrefix: prompt, exit: null });
      boundary = null; prompt = "";
    } else if (m.kind === "end") {
      if (cmds.length) cmds[cmds.length - 1].exit = m.exit ?? null;
    }
  }
  if (!cmds.length) return [];

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
    const outLines = lines.filter(ln => ln.byte >= c.submitByte && ln.byte < endByte).map(ln => ln.text);
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
 * Full session parse: header -> replay -> timing -> entries.
 * ------------------------------------------------------------------------- */
const dec = new TextDecoder("utf-8");

function firstLine(bytes: Uint8Array): { text: string; end: number } {
  let nl = -1;
  for (let i = 0; i < bytes.length && i < 4096; i++) { if (bytes[i] === 0x0a) { nl = i; break; } }
  if (nl < 0) return { text: dec.decode(bytes.slice(0, Math.min(bytes.length, 4096))), end: bytes.length };
  return { text: dec.decode(bytes.slice(0, nl)), end: nl + 1 };
}

export function parseSession(name: string, bytes: Uint8Array, timeText: string | null, promptSrc?: string, cwdSrc?: string): ParsedSession {
  const hdr = firstLine(bytes);
  const h = hdr.text;
  const started = (h.match(/Script started on\s+(.+?)\s*\[/) || [])[1] || "";
  const cols = parseInt((h.match(/COLUMNS="?(\d+)/) || [])[1] || "0", 10) || 80;
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
  const timing = buildTiming(timeText);
  const { lines, titles, marks } = replay(body, cols, rows);
  const entries = extractEntries(lines, titles, marks, promptSrc, cwdSrc);

  for (const e of entries) {
    if (timing && startEpoch != null) e.at = new Date(startEpoch + timing(e.byte) * 1000);
  }
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i].at ? entries[i].at!.getTime() : null;
    const b2 = (i + 1 < entries.length && entries[i + 1].at) ? entries[i + 1].at!.getTime() : (endEpoch != null ? endEpoch : null);
    entries[i].dur = (a != null && b2 != null && b2 >= a) ? (b2 - a) / 1000 : null;
  }

  return { name, tty, term, cols, rows, started, done, exit, startEpoch, endEpoch, hasTiming: !!timing, entries };
}
