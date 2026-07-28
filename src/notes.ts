/*
 * Markdown/frontmatter note builder — kept format-identical to mqor's
 * loglady.html "Download Obsidian Vault" export (same frontmatter keys, same
 * command-note shape, same [[wikilink]] convention) so notes created by
 * either tool share one consistent Dataview schema in the same vault.
 */
import type { CommandEntry } from "./parser";

export function fmtTime(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleString([], { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtDur(s: number | null): string {
  if (s == null) return "";
  if (s < 1) return Math.round(s * 1000) + "ms";
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m + "m" + (r ? " " + r + "s" : "");
}

export function slugFile(s: string, max = 60): string {
  let x = (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!x) x = "note";
  return x.slice(0, max).replace(/-+$/, "") || "note";
}

export function uniqueName(base: string, used: Set<string>): string {
  let name = base, n = 2;
  while (used.has(name)) { name = base + "-" + n; n++; }
  used.add(name);
  return name;
}

export function yamlScalar(v: string | null | undefined): string {
  const s = String(v == null ? "" : v);
  if (s === "") return '""';
  if (/^[A-Za-z0-9_./ -]+$/.test(s) && !/^[-?:,[\]{}#&*!|>'"%@`\s]/.test(s) && !/\s$/.test(s)) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function yamlList(items: string[]): string {
  const arr = (items || []).map(x => x.trim()).filter(Boolean);
  if (!arr.length) return "[]";
  return "[" + arr.map(yamlScalar).join(", ") + "]";
}

/** Title used for the session's index note, mirroring loglady.html's niceName(). */
export function sessionTitle(name: string, startEpoch: number | null): string {
  if (startEpoch) return fmtDate(new Date(startEpoch));
  return name.replace(/_shell\.log$/, "");
}

/** Markdown block for one command — the "insert at cursor" shape (no frontmatter). */
export function commandMarkdown(e: CommandEntry): string {
  const L: string[] = [];
  L.push("### `" + (e.command || "(command)") + "`", "");
  const meta: string[] = [];
  if (e.cwd) meta.push("cwd `" + e.cwd + "`");
  if (e.at) meta.push(fmtTime(e.at));
  if (e.dur != null && e.dur > 0) meta.push("took " + fmtDur(e.dur));
  if (meta.length) L.push("*" + meta.join(" · ") + "*", "");
  if (e.output && e.output.trim()) { L.push("```"); L.push(e.output.replace(/\s+$/, "")); L.push("```", ""); }
  return L.join("\n").trimEnd() + "\n";
}

/** One linked note per command, with frontmatter (title/type/session/cwd/at/duration_s/tags). */
export function commandNote(e: CommandEntry, sessionName: string, indexNoteName: string): string {
  const fm: string[] = [];
  fm.push("---");
  fm.push("title: " + yamlScalar(e.command || "(command)"));
  fm.push("type: command");
  fm.push("session: " + yamlScalar(sessionName));
  fm.push("tags: " + yamlList([]));
  if (e.cwd) fm.push("cwd: " + yamlScalar(e.cwd));
  if (e.at) fm.push("at: " + e.at.toISOString());
  if (e.dur != null && e.dur > 0) fm.push("duration_s: " + e.dur.toFixed(2));
  fm.push("---", "");

  const nb: string[] = [];
  nb.push("# `" + (e.command || "(command)") + "`", "");
  nb.push("[[" + indexNoteName + "]]", "");
  const meta: string[] = [];
  if (e.cwd) meta.push("cwd `" + e.cwd + "`");
  if (e.at) meta.push(fmtTime(e.at));
  if (e.dur != null && e.dur > 0) meta.push("took " + fmtDur(e.dur));
  if (meta.length) nb.push("*" + meta.join(" · ") + "*", "");
  if (e.output && e.output.trim()) { nb.push("```"); nb.push(e.output.replace(/\s+$/, "")); nb.push("```", ""); }

  return fm.concat(nb).join("\n").trimEnd() + "\n";
}

/** The session's index note: frontmatter + a wikilink list of its commands, in order. */
export function indexNote(title: string, entries: { name: string }[]): string {
  const body: string[] = [];
  body.push("---");
  body.push("title: " + yamlScalar(title));
  body.push("type: page");
  body.push("generated: " + new Date().toISOString());
  body.push("---", "");
  body.push("# " + title, "");
  for (const e of entries) body.push("- [[" + e.name + "]]");
  return body.join("\n").trimEnd() + "\n";
}
