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

function session(body, { cols = 80, rows = 24, widthOverride } = {}) {
  const text =
    `Script started on 2026-01-05 10:00:00-05:00 [TERM="xterm-256color" TTY="/dev/pts/0" COLUMNS="${cols}" LINES="${rows}"]\r\n` +
    body +
    `Script done on 2026-01-05 10:30:00-05:00 [COMMAND_EXIT_CODE="0"]\r\n`;
  return parseSession("t_shell.log", enc(text), null, undefined, undefined, widthOverride);
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

test("bracketed paste splits commands without a matching prompt regex", async () => {
  const s = await session(pasteBlock("echo one", "one") + pasteBlock("echo two", "two") + pasteBlock("exit", ""));
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["echo one", "echo two", "exit"]);
  const one = s.entries.find(e => e.command === "echo one");
  assert.equal(one.output, "one");
  assert.equal(s.entries.find(e => e.command === "echo two").output, "two");
  assert.equal(s.entries.find(e => e.command === "exit").noise, true);
});

test("the command is read off the final screen, so redraws and edits resolve", async () => {
  // Type "grep", then the shell recalls and rewrites the line to "grep -ri foo"
  // with cursor motion and overwrites — the reconstructed command is the final
  // visible text, not the concatenation of keystrokes.
  const typed =
    "grep" +               // initial keystrokes
    `${ESC}[4D` +          // cursor back to start of the word
    `${ESC}[Kgrep -ri foo`; // erase to EOL and lay down the final command
  const s = await session(`$ ${ESC}[?2004h${typed}${ESC}[?2004l\r\nmatch\r\n`);
  assert.equal(s.entries[0].command, "grep -ri foo");
  assert.equal(s.entries[0].output, "match");
});

test("a bare Enter at the prompt is a boundary, not a command", async () => {
  const s = await session(pasteBlock("", "") + pasteBlock("ls", "file") + pasteBlock("", ""));
  const real = s.entries.filter(e => !e.noise);
  assert.deepEqual(real.map(e => e.command), ["ls"]);
  assert.ok(s.entries.every(e => e.command !== "" || e.noise), "empty commands are marked noise");
});

test("a wrapped command line is reassembled across rows", async () => {
  const long = "echo " + "x".repeat(90); // longer than 40 cols -> wraps
  const s = await session(`$ ${ESC}[?2004h${long}${ESC}[?2004l\r\ndone\r\n`, { cols: 40, rows: 10 });
  assert.equal(s.entries[0].command, long);
});

test("OSC 133 A/B/C/D marks split commands and capture the exit code", async () => {
  const ST = `${ESC}\\`;
  const block = (cmd, out, code) =>
    `${ESC}]133;A${ST}fancyprompt$ ${ESC}]133;B${ST}${cmd}${ESC}]133;C${ST}\r\n` +
    (out ? out + "\r\n" : "") +
    `${ESC}]133;D;${code}${ST}`;
  const s = await session(block("whoami", "root", 0) + block("false", "", 1));
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["whoami", "false"]);
  assert.equal(s.entries.find(e => e.command === "whoami").exit, 0);
  assert.equal(s.entries.find(e => e.command === "false").exit, 1);
  assert.equal(s.entries.find(e => e.command === "whoami").output, "root");
});

test("OSC 133 prompt-start keeps the prompt banner out of the prior output", async () => {
  const ST = `${ESC}\\`;
  const block = (cmd, out) =>
    `${ESC}]133;A${ST}myhost:~$ ${ESC}]133;B${ST}${cmd}${ESC}]133;C${ST}\r\n` + (out ? out + "\r\n" : "");
  const s = await session(block("pwd", "/home") + block("id", "uid=0"));
  // pwd's output is exactly its own, with no bleed of id's prompt line.
  assert.equal(s.entries.find(e => e.command === "pwd").output, "/home");
});

test("output survives when the submit marker trails the command's newline", async () => {
  // smbclient (and ftp, many REPLs) emit ?2004h, draw their own prompt and the
  // command, end the line, and only THEN emit ?2004l — so the first output
  // line's byte precedes the submit marker. Anchoring output on the submit byte
  // dropped that line, which for a one-line result (most smb commands) meant the
  // whole output vanished. Captured from a real `smbclient` session.
  const block = (cmd, out) => `${ESC}[?2004hsmb: \\> ${cmd}\r\n${ESC}[?2004l\r` + (out ? out + "\r\n" : "");
  const s = await session(block("ls", "file-a  file-b") + block("get x", "getting file x") + block("exit", ""));
  const ls = s.entries.find(e => e.command.endsWith("ls"));
  const get = s.entries.find(e => e.command.endsWith("get x"));
  assert.equal(ls.output, "file-a  file-b", "multi-run: first output line not dropped");
  assert.equal(get.output, "getting file x", "single-line output not lost to the submit-byte window");
});

test("a long command that scrolls the screen while typed is still read whole", async () => {
  // On a short screen the wrapping command scrolls, moving its first row up. The
  // input row has to follow the scroll, or the command reads from a stale row
  // and comes out a fragment. This is the shape of the recalled-command bug.
  const cmd = "echo " + "z".repeat(120);
  const body = "l1\r\nl2\r\nl3\r\nl4\r\n$ " + ESC + "[?2004h" + cmd + ESC + "[?2004l\r\ndone\r\n";
  const s = await session(body, { cols: 24, rows: 6 });
  assert.equal(s.entries.find(e => e.command.startsWith("echo")).command, cmd);
});

test("an explicit width override replaces the recording's header COLUMNS", async () => {
  const body = "$ " + ESC + "[?2004h" + "ls -la" + ESC + "[?2004l\r\nfile\r\n";
  const s = await session(body, { cols: 200, rows: 24, widthOverride: 40 });
  assert.equal(s.cols, 40, "override wins over the header's 200");
  assert.equal(s.entries.find(e => e.command.startsWith("ls")).command, "ls -la");
});

test("a blanked input row falls back to the shell's own title for the command", async () => {
  // A completion/history widget can erase the input row as part of its own
  // redraw dance an instant before Enter, so nothing is left on screen at
  // submit even though the shell really ran something. Found in a real
  // capture: `net rpc group addmem "EXCHANGE WINDOWS PERMISSIONS" ... -I ...`
  // vanished from the reconstruction entirely (silently classed as a
  // bare-Enter no-op) because the row was blank at the exact submit byte.
  // zsh's preexec hook sets the window title (OSC 2) to the literal command
  // right as it starts, so it survives even when the screen doesn't.
  const cmd = 'net rpc group addmem "EXCHANGE WINDOWS PERMISSIONS" "svc-alfresco"';
  const block =
    `$ ${ESC}[?2004h${cmd}\r${ESC}[K${ESC}[?2004l\r\n` + // typed, then the row is wiped before submit
    `${ESC}]2;${cmd}${ESC}\\` + // the shell's own record of what it ran
    `ok\r\n`;
  const s = await session(block);
  const entry = s.entries.find(e => e.command === cmd);
  assert.ok(entry, "the title-derived command is recovered instead of dropped as noise");
  assert.equal(entry.noise, false);
});

test("a blanked input row with no usable title stays noise, not garbage", async () => {
  // Same blanked-row shape, but the following title is the idle "user@host:
  // cwd" one (no command actually ran) -- must not be mistaken for a command.
  const block = `$ ${ESC}[?2004h${ESC}[?2004l\r\n${ESC}]2;user@host: ~${ESC}\\`;
  const s = await session(block);
  const real = s.entries.filter(e => !e.noise);
  assert.equal(real.length, 0, "the idle cwd title is never mistaken for a command");
});

test("two submits on the exact same screen row don't collapse into one", async () => {
  // A history/completion widget can redraw entirely via CR (no linefeed), so
  // two genuinely distinct submits land on the identical absolute row with no
  // scroll between them. xterm.js's current row is not a unique ordinal by
  // itself, so both submits used to get the same byte -- silently merging two
  // real commands into a single ambiguous entry with an unresolvable output
  // window. Found via a real capture with heavy in-place history editing.
  const ST = `${ESC}\\`;
  const block =
    `${ESC}]133;A${ST}$ ${ESC}]133;B${ST}first${ESC}]133;C${ST}\r` + // CR only: same row
    `${ESC}]133;A${ST}$ ${ESC}]133;B${ST}second${ESC}]133;C${ST}\r\n`;
  const s = await session(block);
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["first", "second"]);
  assert.notEqual(s.entries[0].byte, s.entries[1].byte, "each submit gets its own ordering key");
});

test("a title-derived command still anchors its output window correctly", async () => {
  // The screen-scraped command's own row is stale/meaningless once we've
  // fallen back to the title (see above) -- anchoring the output window on it
  // anyway swept in unrelated leftover content from earlier in the same edit
  // marathon. The window must start fresh at the submit itself.
  const cmd = 'net rpc group addmem "EXCHANGE WINDOWS PERMISSIONS" "svc-alfresco"';
  const block =
    `stale leftover content\r\n` + // sits on an early row that inputRow would stale-point to
    `$ ${ESC}[?2004h${cmd}\r${ESC}[K${ESC}[?2004l\r\n` +
    `${ESC}]2;${cmd}${ESC}\\` +
    `real output\r\n`;
  const s = await session(block);
  const entry = s.entries.find(e => e.command === cmd);
  assert.ok(entry);
  assert.equal(entry.output, "real output", "only this command's own output, not the earlier stale content");
});

test("a same-row retry doesn't erase the previous attempt's brief output", async () => {
  // A fast retry loop can jump the cursor back onto an earlier prompt's own
  // row and retype directly over it, with no scroll in between -- but the
  // interrupted attempt's output (its `^C` echo, e.g.) can still be sitting
  // a row or two below that point, about to be clobbered by the retype.
  // xterm.js only exposes the *final* settled state of each row, so unlike a
  // real terminal (which a human watching would have seen this on), that
  // content has to be captured at the moment it's still there or it's gone
  // for good. Found via a real capture with a burst of `^C`-interrupted
  // retries of the same command.
  const body =
    `$ ${ESC}[?2004hfirst${ESC}[?2004l\r\n` + // submit; cursor moves to a fresh row
    `^C\r\n` + // the interrupted attempt's brief output, one row down
    `${ESC}[A${ESC}[A` + // jump back up onto "first"'s own prompt row (no scroll)
    `$ ${ESC}[?2004hsecond${ESC}[?2004l\r\n` +
    `real output\r\n`;
  const s = await session(body);
  const cmds = s.entries.map(e => e.command);
  assert.deepEqual(cmds, ["first", "second"]);
  assert.equal(s.entries[0].output, "^C", "the interrupted attempt's output survives the same-row retype");
  assert.equal(s.entries[1].output, "real output", "the retry's own output is unaffected");
});

test("without marks, extraction falls back to the prompt regex", async () => {
  // No 2004h/2004l and no OSC 133 -> the dispatcher uses the regex path.
  const { lines, titles, marks } = await replay(
    enc("sh-5.1$ echo hi\r\nhi\r\nsh-5.1$ exit\r\n"), 80, 24
  );
  assert.equal(marks.length, 0, "no marks recovered from a plain typescript");
  const entries = extractEntries(lines, titles, marks, String.raw`^sh-5\.1\$\s?(.*)$`, "");
  assert.deepEqual(entries.map(e => e.command), ["echo hi", "exit"]);
  assert.equal(entries.find(e => e.command === "echo hi").output, "hi");
});
