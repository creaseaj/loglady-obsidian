/*
 * Differential tests: our terminal emulator against xterm.js.
 *
 * src/parser.ts hand-rolls a VT emulator because it has to run inside a
 * dependency-free, Obsidian-API-free module shared with loglady.html, and
 * because it needs a byte offset per reconstructed line to drive timestamps
 * from the timing file — neither of which xterm.js gives us. That is a good
 * reason not to *ship* xterm.js, and no reason at all to guess at escape
 * sequences: @xterm/headless is a dev dependency here, replaying the same
 * bytes as an oracle so any divergence shows up as a failing test.
 *
 * Two divergences are deliberate and asserted as such at the bottom of this
 * file: LogLady reconstructs a session log, not a screen, so content a screen
 * emulator legitimately throws away is content we keep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import xterm from "@xterm/headless";
import { replay } from "../src/parser.ts";

const { Terminal } = xterm;
const __dirname = dirname(fileURLToPath(import.meta.url));

const COLS = 40, ROWS = 8;
const ESC = "\x1b";
const enc = s => new TextEncoder().encode(s);

function trimTail(lines) {
  const a = lines.slice();
  while (a.length && a[a.length - 1] === "") a.pop();
  return a;
}

/** Reconstructed logical lines, ours. */
function ours(bytes, cols = COLS, rows = ROWS) {
  return trimTail(replay(bytes, cols, rows).lines.map(l => l.text));
}

/** The same, via xterm.js: scrollback + screen, wrapped rows rejoined. */
async function theirs(bytes, cols = COLS, rows = ROWS) {
  const term = new Terminal({ cols, rows, scrollback: 100000, allowProposedApi: true });
  await new Promise(done => term.write(bytes, done));
  const buf = term.buffer.active;
  const out = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(false);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  term.dispose();
  return trimTail(out.map(t => t.replace(/\s+$/, "")));
}

/*
 * Cases both engines must agree on. Each is a raw byte stream as a shell or a
 * full-screen program would emit it.
 */
const AGREE = {
  "plain lines": "one\r\ntwo\r\nthree\r\n",
  "scrolls past the screen": Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\r\n") + "\r\n",
  "autowrap at exact width": "0".repeat(COLS) + `${ESC}[2;1H` + "next\r\n",
  "long wrapped line": "x".repeat(COLS * 2 + 5) + "\r\n",
  "CR overwrite (progress bar)": "10%\r50%\r100%\r\ndone\r\n",
  "erase to end of line": `keep this${ESC}[5Dxxxx${ESC}[K\r\n`,
  "erase display to start (ED1)": `aaa\r\nbbb\r\nccc${ESC}[2;2H${ESC}[1J\r\n`,
  "tab stops": "a\tb\tc\r\n",
  "insert/delete chars": `abcdef${ESC}[1;3H${ESC}[2@${ESC}[2P\r\n`,
  "insert mode (IRM)": `abcdef${ESC}[1;1H${ESC}[4hXY${ESC}[4l\r\n`,
  "autowrap disabled (DECAWM off)": `${ESC}[?7l` + "z".repeat(COLS + 10) + `${ESC}[?7h\r\n`,
  "cursor up + redraw": `first\r\nsecond\r\n${ESC}[2A${ESC}[Krewritten\r\n`,
  "backspace erase": "abcdef\b\b\bXYZ\r\n",
  "carriage return mid-wrap": "y".repeat(COLS + 5) + "\rZZ\r\n",
  "CUP out of range clamps": `${ESC}[99;99Hedge\r\n`,
  "save/restore cursor (DECSC/DECRC)": `${ESC}7abc\r\ndef${ESC}8XYZ\r\n`,
  "reverse index (ESC M)": `top\r\nbottom${ESC}Mup-one\r\n`,
  "insert line (CSI L) in a scroll region": `${ESC}[3;6r${ESC}[3;1Ha\r\nb\r\nc\r\n${ESC}[Linserted\r\n`,
  "delete line (CSI M)": `l1\r\nl2\r\nl3\r\n${ESC}[1;1H${ESC}[M`,
  "alternate screen round trip": `shell line\r\n${ESC}[?1049hTUI FRAME\r\nMORE TUI\r\n${ESC}[?1049lback in shell\r\n`,
  "pager: alt screen + region + reverse index":
    `${ESC}[?1049h${ESC}[1;5r${ESC}[1;1Hp1\r\np2\r\np3\r\np4\r\np5\r\n${ESC}M${ESC}Mscrolled-back\r\n${ESC}[?1049lafter pager\r\n`,
  "zsh-style prompt redraw": `${ESC}7user@host $ ${ESC}8${ESC}[Kuser@host $ ls\r\nfile-a  file-b\r\n`,
  "top-style partial clears": `${ESC}[H${ESC}[2Jheader\r\nrow1\r\n${ESC}[H${ESC}[Jheader\r\nrow2\r\n`,
  "wide characters (CJK)": "日本語テキスト\r\nnext\r\n",
  "combining marks": "éclair\r\n",

  // Sequences carrying intermediate bytes, sub-parameters, or string payloads.
  // Each of these used to spill part of itself into the text as literal
  // characters, which is the failure mode that actually reaches a note.
  "cursor style (CSI SP q)": `${ESC}[2 qprompt $ ls\r\n`,
  "other CSI intermediates (DECSCA)": `${ESC}[1"qtext\r\n`,
  "soft reset (CSI ! p)": `${ESC}[!ptext\r\n`,
  "SGR with colon sub-parameters": `${ESC}[38:2::255:0:0mred${ESC}[0m\r\n`,
  "DCS sixel graphics": `before\r\n${ESC}Pq#0;2;0;0;0#0~~@@vv@@~~@@~~$${ESC}\\after\r\n`,
  "DCS DECRQSS reply": `before\r\n${ESC}P1$r0;1m${ESC}\\after\r\n`,
  "APC string (kitty graphics)": `before\r\n${ESC}_Ga=T,f=100;base64data${ESC}\\after\r\n`,
  "PM string": `before\r\n${ESC}^privmsg${ESC}\\after\r\n`,
  "DEC line drawing charset": `${ESC}(0lqqqk${ESC}(B\r\nplain\r\n`,
  "REP repeat last character (CSI b)": `a${ESC}[5b\r\n`,
  "HPA / VPA absolute positioning": `${ESC}[10\`X${ESC}[3dY\r\n`,
  "device status report request": `${ESC}[6ntext\r\n`,
  "window manipulation (CSI t)": `${ESC}[8;24;80ttext\r\n`,
  "bracketed paste markers": `${ESC}[200~pasted text${ESC}[201~\r\n`,

  // A zsh prompt redraw as it actually appears in a recording: type into the
  // last column (arming autowrap and marking the row as continued), carriage
  // return, then ESC[J and a fresh prompt banner drawn beneath. The erase has
  // to sever the continuation, or the command line glues onto the banner and
  // the banner line the cwd regex reads disappears. Found in a real Kali log.
  "prompt redraw after end-of-row + ED": "ex" + " ".repeat(COLS - 2) + `\r${ESC}[J┌──(user)-[~]\r\n└─$ exit\r\n`,
  "erase-line severs a wrapped continuation": "x".repeat(COLS) + `redraw\r${ESC}[2Kfresh\r\n`,
};

for (const [name, body] of Object.entries(AGREE)) {
  test(`matches xterm.js: ${name}`, async () => {
    const bytes = enc(body);
    assert.deepEqual(ours(bytes), await theirs(bytes));
  });
}

test("matches xterm.js: the recorded sample session", async () => {
  const bytes = new Uint8Array(readFileSync(join(__dirname, "fixtures", "sample_shell.log")));
  assert.deepEqual(ours(bytes, 120, 30), await theirs(bytes, 120, 30));
});

/* --------------------------------------------------------------------------
 * Deliberate divergences. Both assert what we do *and* that xterm.js does the
 * other thing, so if xterm.js ever changes its mind these fail loudly rather
 * than quietly agreeing for the wrong reason.
 * ------------------------------------------------------------------------ */

test("divergence: a full erase keeps history that xterm.js discards", async () => {
  // `clear` sends ESC[H ESC[2J ESC[3J. A screen emulator drops whatever was on
  // screen; a session log must not — those are the user's last commands.
  const bytes = enc(`before-1\r\nbefore-2\r\n${ESC}[H${ESC}[2J${ESC}[3Jafter-1\r\n`);
  assert.deepEqual(ours(bytes), ["before-1", "before-2", "after-1"]);
  assert.deepEqual(await theirs(bytes), ["after-1"]);
});

test("divergence: an explicit scroll-up keeps the lines it scrolls past", async () => {
  // CSI S on the full screen scrolls content off the top. xterm.js drops it;
  // we keep it, for the same reason as the erase above.
  const bytes = enc(`a\r\nb\r\nc\r\n${ESC}[2Sd\r\n`);
  assert.ok(ours(bytes).includes("a"), "the scrolled-off line stays in our history");
  assert.ok(!(await theirs(bytes)).includes("a"), "xterm.js drops it");
});

test("divergence: a full reset (RIS) keeps what was on screen", async () => {
  // Same principle again: ESC c wipes the display, but the commands above it
  // are session history, not screen state.
  const bytes = enc(`junk\r\n${ESC}cafter reset\r\n`);
  assert.deepEqual(ours(bytes), ["junk", "after reset"]);
  assert.deepEqual(await theirs(bytes), ["after reset"]);
});

test("known simplification: tmux's DCS passthrough payload is dropped", async () => {
  // xterm.js special-cases `DCS tmux; ... ST` and replays the wrapped payload
  // as if it had arrived directly. Every other DCS flavour (sixel, DECRQSS) is
  // consumed by both engines and asserted above; this one only shows up in
  // recordings made inside tmux with a passthrough-emitting integration, so it
  // stays a documented gap rather than a special case in the emulator.
  const bytes = enc(`before\r\n${ESC}Ptmux;${ESC}[31mpayload${ESC}\\after\r\n`);
  assert.deepEqual(ours(bytes), ["before", "after"]);
  assert.deepEqual(await theirs(bytes), ["before", "payloadafter"]);
});
