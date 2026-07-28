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

test("parses header fields", () => {
  const s = loadSession();
  assert.equal(s.tty, "/dev/pts/3");
  assert.equal(s.term, "xterm-256color");
  assert.equal(s.cols, 120);
  assert.equal(s.rows, 30);
  assert.equal(s.exit, 0);
  assert.ok(s.hasTiming);
});

test("splits commands at prompts, in order", () => {
  const s = loadSession();
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["nmap -sV 10.0.0.5", "whoami", "exit"]);
});

test("captures output for each command", () => {
  const s = loadSession();
  const nmap = s.entries.find(e => e.command === "nmap -sV 10.0.0.5");
  assert.ok(nmap.output.includes("22/tcp open  ssh     OpenSSH 8.9"));
  assert.ok(nmap.output.includes("80/tcp open  http    nginx 1.24"));
  const who = s.entries.find(e => e.command === "whoami");
  assert.equal(who.output, "tester");
});

test("flags the trailing exit as noise, others not", () => {
  const s = loadSession();
  const byCmd = Object.fromEntries(s.entries.map(e => [e.command, e.noise]));
  assert.equal(byCmd["exit"], true);
  assert.equal(byCmd["nmap -sV 10.0.0.5"], false);
  assert.equal(byCmd["whoami"], false);
});

test("computes timestamps and durations from the timing file", () => {
  const s = loadSession();
  const nmap = s.entries.find(e => e.command === "nmap -sV 10.0.0.5");
  assert.ok(nmap.at instanceof Date);
  // start (10:00:00) + first two timing deltas (0.2 + 2.1) before the command echoes back
  assert.ok(nmap.dur > 0);
  const who = s.entries.find(e => e.command === "whoami");
  assert.ok(who.at > nmap.at, "whoami should be timestamped after nmap");
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

test("replay: deferred autowrap does not false-join redraw noise in the last column", () => {
  // A write that lands exactly in the last column parks the cursor (pendingWrap);
  // a subsequent cursor move (not a printable char) must cancel it, so the next
  // line is NOT treated as a continuation of this one.
  const cols = 10, rows = 5;
  const line = "0123456789"; // exactly fills the row, would set pendingWrap
  const move = "\x1b[2;1H"; // CSI cursor-position elsewhere — cancels pendingWrap without overwriting row 1
  const next = "next line\n";
  const bytes = new TextEncoder().encode(line + move + next);
  const { lines } = replay(bytes, cols, rows);
  assert.ok(lines.some(l => l.text === "0123456789"), "full-width line preserved");
  assert.ok(lines.some(l => l.text === "next line"), "next line stays separate, not joined");
});

test("replay: CRLF line endings do not duplicate or misplace text", () => {
  const bytes = new TextEncoder().encode("first\r\nsecond\r\nthird\r\n");
  const { lines } = replay(bytes, 40, 10);
  assert.deepEqual(lines.map(l => l.text), ["first", "second", "third"]);
});
