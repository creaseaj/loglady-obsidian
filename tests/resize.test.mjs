/*
 * Resize-aware replay. util-linux `script --logging-format advanced` records
 * terminal resizes (`S <delay> SIGWINCH ROWS=<r> COLS=<c>`); applying them at
 * the right byte keeps wrapping aligned with the terminal the shell actually
 * saw. Without it, a session whose width changed mid-recording reconstructs at
 * one fixed width, and any wrapped redraw after the change is mangled — the
 * real-world failure was a recalled long command whose erase-line redraw, at
 * the wrong width, wiped the front of the command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import xterm from "@xterm/headless";
import { replay, buildTiming, parseResizes } from "../src/parser.ts";

const { Terminal } = xterm;
const ESC = "\x1b";
const enc = s => new TextEncoder().encode(s);
const trimTail = a => { a = a.slice(); while (a.length && a.at(-1) === "") a.pop(); return a; };

const ADV = [
  "H 0.000000 COLUMNS 100",
  "H 0.000000 LINES 50",
  "O 0.010000 18",
  "O 0.200000 20",
  "S 0.400000 SIGWINCH ROWS=50 COLS=60",
  "O 0.100000 8",
  "S 1.000000 SIGWINCH ROWS=24 COLS=80",
  "O 0.050000 5",
].join("\n");

test("parseResizes reads SIGWINCH records at their output-byte offset", () => {
  assert.deepEqual(parseResizes(ADV), [
    { byte: 38, rows: 50, cols: 60 },   // after 18 + 20 output bytes
    { byte: 46, rows: 24, cols: 80 },   // after a further 8
  ]);
});

test("parseResizes is empty for a classic timing file", () => {
  assert.deepEqual(parseResizes("0.1 18\n0.2 20\n"), []);
});

test("buildTiming maps offsets from advanced O records, folding in wait time", () => {
  const at = buildTiming(ADV);
  assert.ok(at, "advanced timing builds");
  // byte 38 is reached after O deltas 0.01 + 0.20 (= 0.21); the following
  // SIGWINCH's 0.40 wait folds into the next O, so the map stays monotonic.
  assert.ok(Math.abs(at(38) - 0.21) < 1e-9, "elapsed at the resize boundary");
  assert.ok(at(46) >= at(38), "monotonic across the signal record");
});

test("a resize rescues a redraw that a fixed width would mangle", async () => {
  // A command drawn then edited with CR + erase-line + rewrite of the tail.
  // At a NARROW width it wraps, so erase-line only clears the last row and the
  // command survives. At a WIDE width it's one row, so erase-line wipes all of
  // it and only the rewritten tail is left — exactly the reported corruption.
  const body = "cmd-" + "a".repeat(40) + "\r" + ESC + "[K" + "bbbb";

  const wideResult = await replay(enc(body), 100, 24, []);
  const wide = trimTail(wideResult.lines.map(l => l.text));
  assert.deepEqual(wide, ["bbbb"], "no resize, wide: command wiped by erase-line");

  const narrowResult = await replay(enc(body), 100, 24, [{ byte: 0, cols: 30, rows: 24 }]);
  const narrow = trimTail(narrowResult.lines.map(l => l.text));
  assert.ok(narrow.join("").startsWith("cmd-aaaa"), "resize to 30: the command front survives");
  assert.ok(narrow.join("").endsWith("bbbb"), "and the edited tail is kept");
});

test("a resize doesn't truncate output that was already on screen", async () => {
  // On a tall terminal most of the session stays "on screen" (unscrolled) for
  // a long time. A real capture had an `ls` listing written at COLUMNS=476,
  // then several commands later a mid-session resize narrowed to COLS=236 —
  // and the still-unscrolled `ls` line got chopped at the new, narrower width
  // even though it was written and finished long before the resize happened.
  const longLine = "x".repeat(300); // fits at 400 cols, would wrap/truncate at 100
  const body = longLine + "\r\n" + "y".repeat(50) + "\r\n";
  const resizeAt = longLine.length + 2 + 10; // well after the long line is committed
  const { lines } = await replay(enc(body), 400, 50, [{ byte: resizeAt, cols: 100, rows: 50 }]);
  const text = lines.map(l => l.text).join("");
  assert.ok(text.includes(longLine), "the pre-resize line survives the later narrower resize intact");
});

test("our chunked resize handling matches xterm.js's own resize()+reflow", async () => {
  // Sanity check on the wrapper, not the engine (replay() delegates to
  // xterm.js directly now): feeding bytes in chunks split at each resize's
  // byte offset, with term.resize() called between them, must reflow the
  // same way a direct term.write()/term.resize()/term.write() sequence does.
  const pre = "line-at-wide-width\r\n";
  const post = "x".repeat(50) + "\r\n"; // wraps only at the narrow width
  const body = enc(pre + post);
  const at = pre.length;

  const oursResult = await replay(body, 100, 24, [{ byte: at, cols: 40, rows: 24 }]);
  const ours = trimTail(oursResult.lines.map(l => l.text.replace(/\s+$/, "")));

  const term = new Terminal({ cols: 100, rows: 24, scrollback: 500, allowProposedApi: true });
  await new Promise(r => term.write(enc(pre), r));
  term.resize(40, 24);
  await new Promise(r => term.write(enc(post), r));
  const buf = term.buffer.active, theirs = [];
  for (let y = 0; y < buf.length; y++) {
    const l = buf.getLine(y); if (!l) continue;
    const s = l.translateToString(false);
    if (l.isWrapped && theirs.length) theirs[theirs.length - 1] += s; else theirs.push(s);
  }
  term.dispose();
  // The post-resize wrapped line reassembles the same via both paths.
  assert.ok(ours.includes("x".repeat(50)), "our post-resize line reflows to one logical line");
  assert.ok(trimTail(theirs.map(s => s.replace(/\s+$/, ""))).includes("x".repeat(50)), "direct xterm.js usage agrees");
});
