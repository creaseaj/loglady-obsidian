/*
 * History preservation across a full erase / reset / explicit scroll.
 *
 * replay() is a thin wrapper around @xterm/headless now — VT correctness
 * (wrapping, scroll regions, charsets, string sequences, ...) is xterm.js's
 * own well-tested responsibility, not something this project re-verifies.
 * What IS this project's responsibility, and what these tests guard, is the
 * one deliberate way replay() behaves differently from a screen emulator:
 * LogLady reconstructs a session log, not a screen, so content a screen
 * emulator legitimately discards (whatever was on screen, not yet scrolled
 * away, when the screen gets wiped) is content this tool keeps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { replay } from "../src/parser.ts";

const ESC = "\x1b";
const enc = s => new TextEncoder().encode(s);
const trimTail = a => { a = a.slice(); while (a.length && a.at(-1) === "") a.pop(); return a; };

test("a full erase (clear) keeps commands still on screen", async () => {
  // `clear` sends ESC[H ESC[2J ESC[3J. A plain screen emulator drops
  // before-1/before-2 -- they were never scrolled off, ED just wipes them --
  // taking the user's last commands with it. That was the original bug this
  // engine exists to fix.
  const bytes = enc(`before-1\r\nbefore-2\r\n${ESC}[H${ESC}[2J${ESC}[3Jafter-1\r\n`);
  const { lines } = await replay(bytes, 40, 8);
  assert.deepEqual(trimTail(lines.map(l => l.text)), ["before-1", "before-2", "after-1"]);
});

test("an explicit scroll-up keeps the lines it scrolls past", async () => {
  // CSI S scrolls the full screen -- an actual scroll, so xterm.js's own
  // scrollback already keeps this; nothing custom needed here, but it's
  // worth pinning down since it's easy to confuse with the ED/RIS cases above.
  const bytes = enc(`a\r\nb\r\nc\r\n${ESC}[2Sd\r\n`);
  const { lines } = await replay(bytes, 40, 8);
  assert.ok(trimTail(lines.map(l => l.text)).includes("a"), "the scrolled-off line stays in history");
});

test("a full reset (RIS) keeps what was on screen", async () => {
  const bytes = enc(`junk\r\n${ESC}cafter reset\r\n`);
  const { lines } = await replay(bytes, 40, 8);
  assert.deepEqual(trimTail(lines.map(l => l.text)), ["junk", "after reset"]);
});

test("several clears in a row each preserve their own screenful", async () => {
  const body = Array.from({ length: 5 }, (_, i) => `cmd-${i + 1}\r\n${ESC}[H${ESC}[2J${ESC}[3J`).join("") + "final\r\n";
  const { lines } = await replay(enc(body), 40, 8);
  const text = trimTail(lines.map(l => l.text));
  for (let i = 1; i <= 5; i++) assert.ok(text.includes(`cmd-${i}`), `cmd-${i} survives its own clear`);
  assert.ok(text.includes("final"));
});

test("wrapped content still on screen at a clear rejoins correctly", async () => {
  const long = "x".repeat(90); // wraps at cols=40
  const bytes = enc(`${long}\r\n${ESC}[H${ESC}[2J${ESC}[3Jafter\r\n`);
  const { lines } = await replay(bytes, 40, 8);
  const text = trimTail(lines.map(l => l.text));
  assert.ok(text.includes(long), "the wrapped pre-clear line rejoins as one logical line");
});
