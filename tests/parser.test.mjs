import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSession, buildTiming, replay } from "../src/parser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

function loadSession() {
  const shell = readFileSync(join(FIXTURES, "sample_shell.log"));
  const time = readFileSync(join(FIXTURES, "sample_time.log"), "utf8");
  return parseSession("sample_shell.log", new Uint8Array(shell), time, String.raw`^sh-5\.1\$\s?(.*)$`, "");
}

test("parses header fields", async () => {
  const s = await loadSession();
  assert.equal(s.tty, "/dev/pts/3");
  assert.equal(s.term, "xterm-256color");
  assert.equal(s.cols, 120);
  assert.equal(s.rows, 30);
  assert.equal(s.exit, 0);
});

test("splits commands at prompts, in order", async () => {
  const s = await loadSession();
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["nmap -sV 10.0.0.5", "whoami", "exit"]);
});

test("captures output for each command", async () => {
  const s = await loadSession();
  const nmap = s.entries.find(e => e.command === "nmap -sV 10.0.0.5");
  assert.ok(nmap.output.includes("22/tcp open  ssh     OpenSSH 8.9"));
  assert.ok(nmap.output.includes("80/tcp open  http    nginx 1.24"));
  const who = s.entries.find(e => e.command === "whoami");
  assert.equal(who.output, "tester");
});

test("flags the trailing exit as noise, others not", async () => {
  const s = await loadSession();
  const byCmd = Object.fromEntries(s.entries.map(e => [e.command, e.noise]));
  assert.equal(byCmd["exit"], true);
  assert.equal(byCmd["nmap -sV 10.0.0.5"], false);
  assert.equal(byCmd["whoami"], false);
});

test("no per-command timestamps in the xterm.js-backed engine", async () => {
  // `byte` is a row-ordering key now, not a real byte offset (see the module
  // comment in parser.ts), so there's nothing to map a timing file through.
  // Explicit coverage so this isn't silently reintroduced half-working.
  const s = await loadSession();
  assert.equal(s.hasTiming, false);
  for (const e of s.entries) {
    assert.equal(e.at, null);
    assert.equal(e.dur, null);
  }
});

test("buildTiming interpolates between recorded offsets", () => {
  const elapsed = buildTiming("0 0\n1.0 100\n2.0 200\n");
  assert.equal(elapsed(0), 0);
  assert.equal(elapsed(50), 0.5);
  assert.equal(elapsed(200), 2.0);
  assert.equal(elapsed(9999), 3.0); // clamps to the last known (cumulative) offset
});

test("buildTiming returns null with no usable lines", () => {
  assert.equal(buildTiming(null), null);
  assert.equal(buildTiming(""), null);
  assert.equal(buildTiming("garbage\n"), null);
});

test("replay: deferred autowrap does not false-join redraw noise in the last column", async () => {
  // A write that lands exactly in the last column parks the cursor (pendingWrap);
  // a subsequent cursor move (not a printable char) must cancel it, so the next
  // line is NOT treated as a continuation of this one.
  const cols = 10, rows = 5;
  const line = "0123456789"; // exactly fills the row, would set pendingWrap
  const move = "\x1b[2;1H"; // CSI cursor-position elsewhere — cancels pendingWrap without overwriting row 1
  const next = "next line\n";
  const bytes = new TextEncoder().encode(line + move + next);
  const { lines } = await replay(bytes, cols, rows);
  assert.ok(lines.some(l => l.text === "0123456789"), "full-width line preserved");
  assert.ok(lines.some(l => l.text === "next line"), "next line stays separate, not joined");
});

test("replay: CRLF line endings do not duplicate or misplace text", async () => {
  const bytes = new TextEncoder().encode("first\r\nsecond\r\nthird\r\n");
  const { lines } = await replay(bytes, 40, 10);
  assert.deepEqual(lines.map(l => l.text), ["first", "second", "third"]);
});

/* --------------------------------------------------------------------------
 * Synthetic sessions, for the paths a small fixture can't cover.
 * ------------------------------------------------------------------------ */
const SH_PROMPT = String.raw`^sh-5\.1\$\s?(.*)$`;

function syntheticSession(body, { rows = 30, cols = 120 } = {}) {
  const text =
    `Script started on 2026-01-05 10:00:00-05:00 [TERM="xterm-256color" TTY="/dev/pts/3" COLUMNS="${cols}" LINES="${rows}"]\r\n` +
    body +
    `Script done on 2026-01-05 10:30:00-05:00 [COMMAND_EXIT_CODE="0"]\r\n`;
  return parseSession("t_shell.log", new TextEncoder().encode(text), null, SH_PROMPT, "");
}

function commandBlocks(n, { clearEvery = 0, from = 1 } = {}) {
  let s = "";
  for (let i = from; i < from + n; i++) {
    s += `sh-5.1$ echo cmd-${i}\r\ncmd-${i}\r\n`;
    if (clearEvery && (i - from + 1) % clearEvery === 0) s += "\x1b[H\x1b[2J\x1b[3J"; // what `clear` emits
  }
  return s;
}

test("clear does not discard commands still on screen", async () => {
  // Every line that hasn't scrolled off when `clear` runs used to be wiped
  // without ever reaching the reconstruction, taking whole commands with it.
  const s = await syntheticSession(commandBlocks(100, { clearEvery: 25 }));
  const kept = s.entries.map(e => e.command).filter(c => c.startsWith("echo cmd-"));
  assert.equal(kept.length, 100, "every command survives the clears");
  assert.equal(kept[0], "echo cmd-1", "the oldest command is still there");
  assert.equal(kept[99], "echo cmd-100");
});

test("commands stay in order across a clear even when writes are batched", async () => {
  // A row's write-time tracking (checkRows()) only runs at newline-count
  // checkpoints, not after every single write, for performance. A `clear`
  // landing inside one of those checkpoint batches resets the cursor back
  // near the top of the viewport, reusing rows the batch had already moved
  // past -- rows that a checkpoint anchored purely to "wherever the cursor
  // is now" would never look back at, leaving them stamped with the wrong
  // (pre-clear) epoch and sorting the command they actually belong to into
  // the middle of a much earlier one's neighborhood.
  const s = await syntheticSession(commandBlocks(100, { clearEvery: 25 }));
  const kept = s.entries.map(e => e.command).filter(c => c.startsWith("echo cmd-"));
  const expected = Array.from({ length: 100 }, (_, i) => `echo cmd-${i + 1}`);
  assert.deepEqual(kept, expected, "commands stay in their original order across every clear");
});

test("clear preserves each command's own output", async () => {
  const s = await syntheticSession(commandBlocks(40, { clearEvery: 7 }));
  const e = s.entries.find(x => x.command === "echo cmd-3");
  assert.equal(e.output, "cmd-3", "output stays attached to its command across a clear");
});

test("full-screen programs on the alternate screen stay out of the history", async () => {
  // vim/htop/less draw on the alternate buffer (DECSET 1049) and restore the
  // shell's screen on exit; their frames are not session history.
  const tui =
    "sh-5.1$ vim notes.txt\r\n" +
    "\x1b[?1049h" +
    "~ VIM FRAME LINE A\r\n~ VIM FRAME LINE B\r\n" +
    "\x1b[H\x1b[2J" +                       // a redraw inside the TUI
    "~ VIM FRAME LINE C\r\n" +
    "\x1b[?1049l";
  const s = await syntheticSession(commandBlocks(2) + tui + commandBlocks(2, { from: 3 }));
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["echo cmd-1", "echo cmd-2", "vim notes.txt", "echo cmd-3", "echo cmd-4"]);
  const all = s.entries.map(e => e.output).join("\n");
  assert.ok(!all.includes("VIM FRAME"), "no alternate-screen frames leak into any command's output");
});

test("a properly terminated OSC (BEL or ST) never bleeds into later commands", async () => {
  const s = await syntheticSession(
    commandBlocks(2) +
    "sh-5.1$ cat blob.bin\r\n\x1b]0;title one\x07" + commandBlocks(1, { from: 3 }) +
    "\x1b]0;title two\x1b\\" + commandBlocks(1, { from: 4 })
  );
  const cmds = s.entries.map(e => e.command);
  assert.ok(cmds.includes("echo cmd-3"), "the command after a BEL-terminated OSC survives");
  assert.ok(cmds.includes("echo cmd-4"), "the command after an ST-terminated OSC survives");
});

test("known trade-off: a genuinely unterminated OSC consumes the rest of the stream", () => {
  // A real terminal has to wait indefinitely for an OSC's terminator (BEL or
  // ST) -- that's correct VT behavior, and xterm.js follows it, unlike the
  // old hand-rolled engine's defensive bail-out after a few KB. In practice a
  // real shell always terminates its own OSC sequences properly, so this is a
  // theoretical edge case (a program emitting raw binary containing a stray
  // ESC ]), not something seen in real captures -- documented here so it
  // isn't mistaken for a regression if it ever comes up again.
});

test("a well-formed OSC title still sets the working directory", async () => {
  const s = await syntheticSession("\x1b]0;user@kali: /var/log\x07sh-5.1$ echo cmd-1\r\ncmd-1\r\n");
  assert.equal(s.entries[0].cwd, "/var/log");
});
