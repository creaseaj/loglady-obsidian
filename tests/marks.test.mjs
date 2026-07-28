/*
 * Command-boundary detection via shell-integration marks.
 *
 * The regex path (parser.test.mjs) splits on prompt text; these exercise the
 * two structural signals that supersede it — bracketed paste (DECSET 2004) and
 * OSC 133 semantic prompts — which delimit the command input directly, so the
 * command is read off the reconstructed screen and boundaries don't depend on
 * what the prompt looks like.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSession, replay, extractEntries } from "../src/parser.ts";

const ESC = "\x1b";
const enc = s => new TextEncoder().encode(s);

function session(body, { cols = 80, rows = 24 } = {}) {
  const text =
    `Script started on 2026-01-05 10:00:00-05:00 [TERM="xterm-256color" TTY="/dev/pts/0" COLUMNS="${cols}" LINES="${rows}"]\r\n` +
    body +
    `Script done on 2026-01-05 10:30:00-05:00 [COMMAND_EXIT_CODE="0"]\r\n`;
  return parseSession("t_shell.log", enc(text), null);
}

// A zsh-style two-line prompt whose command line is wrapped in bracketed paste.
// The prompt text deliberately does NOT match the default prompt regex, to
// prove the boundary comes from the 2004h/2004l toggles, not the prompt.
function pasteBlock(cmd, output) {
  return (
    `weird%prompt> ` +
    `${ESC}[?2004h${cmd}${ESC}[?2004l\r\n` +
    (output ? output + "\r\n" : "")
  );
}

test("bracketed paste splits commands without a matching prompt regex", () => {
  const s = session(pasteBlock("echo one", "one") + pasteBlock("echo two", "two") + pasteBlock("exit", ""));
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["echo one", "echo two", "exit"]);
  const one = s.entries.find(e => e.command === "echo one");
  assert.equal(one.output, "one");
  assert.equal(s.entries.find(e => e.command === "echo two").output, "two");
  assert.equal(s.entries.find(e => e.command === "exit").noise, true);
});

test("the command is read off the final screen, so redraws and edits resolve", () => {
  // Type "grep", then the shell recalls and rewrites the line to "grep -ri foo"
  // with cursor motion and overwrites — the reconstructed command is the final
  // visible text, not the concatenation of keystrokes.
  const typed =
    "grep" +               // initial keystrokes
    `${ESC}[4D` +          // cursor back to start of the word
    `${ESC}[Kgrep -ri foo`; // erase to EOL and lay down the final command
  const s = session(`$ ${ESC}[?2004h${typed}${ESC}[?2004l\r\nmatch\r\n`);
  assert.equal(s.entries[0].command, "grep -ri foo");
  assert.equal(s.entries[0].output, "match");
});

test("a bare Enter at the prompt is a boundary, not a command", () => {
  const s = session(pasteBlock("", "") + pasteBlock("ls", "file") + pasteBlock("", ""));
  const real = s.entries.filter(e => !e.noise);
  assert.deepEqual(real.map(e => e.command), ["ls"]);
  assert.ok(s.entries.every(e => e.command !== "" || e.noise), "empty commands are marked noise");
});

test("a wrapped command line is reassembled across rows", () => {
  const long = "echo " + "x".repeat(90); // longer than 40 cols -> wraps
  const s = session(`$ ${ESC}[?2004h${long}${ESC}[?2004l\r\ndone\r\n`, { cols: 40, rows: 10 });
  assert.equal(s.entries[0].command, long);
});

test("OSC 133 A/B/C/D marks split commands and capture the exit code", () => {
  const ST = `${ESC}\\`;
  const block = (cmd, out, code) =>
    `${ESC}]133;A${ST}fancyprompt$ ${ESC}]133;B${ST}${cmd}${ESC}]133;C${ST}\r\n` +
    (out ? out + "\r\n" : "") +
    `${ESC}]133;D;${code}${ST}`;
  const s = session(block("whoami", "root", 0) + block("false", "", 1));
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["whoami", "false"]);
  assert.equal(s.entries.find(e => e.command === "whoami").exit, 0);
  assert.equal(s.entries.find(e => e.command === "false").exit, 1);
  assert.equal(s.entries.find(e => e.command === "whoami").output, "root");
});

test("OSC 133 prompt-start keeps the prompt banner out of the prior output", () => {
  const ST = `${ESC}\\`;
  const block = (cmd, out) =>
    `${ESC}]133;A${ST}myhost:~$ ${ESC}]133;B${ST}${cmd}${ESC}]133;C${ST}\r\n` + (out ? out + "\r\n" : "");
  const s = session(block("pwd", "/home") + block("id", "uid=0"));
  // pwd's output is exactly its own, with no bleed of id's prompt line.
  assert.equal(s.entries.find(e => e.command === "pwd").output, "/home");
});

test("without marks, extraction falls back to the prompt regex", () => {
  // No 2004h/2004l and no OSC 133 -> the dispatcher uses the regex path.
  const { lines, titles, marks } = replay(
    enc("sh-5.1$ echo hi\r\nhi\r\nsh-5.1$ exit\r\n"), 80, 24
  );
  assert.equal(marks.length, 0, "no marks recovered from a plain typescript");
  const entries = extractEntries(lines, titles, marks, String.raw`^sh-5\.1\$\s?(.*)$`, "");
  assert.deepEqual(entries.map(e => e.command), ["echo hi", "exit"]);
  assert.equal(entries.find(e => e.command === "echo hi").output, "hi");
});
