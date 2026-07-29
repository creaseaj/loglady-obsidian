/*
 * Markdown builder for the one thing the panel emits: the block dropped into a
 * note when a command is dragged onto it.
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

/** Title shown for a session's group header in the panel. */
export function sessionTitle(name: string, startEpoch: number | null): string {
  if (startEpoch) return fmtDate(new Date(startEpoch));
  return name.replace(/_shell\.log$/, "");
}

/** Markdown block for one command — what a dragged row drops into a note. */
export function commandMarkdown(e: CommandEntry): string {
  const L: string[] = [];
  L.push("### `" + (e.command || "(command)") + "`", "");
  const meta: string[] = [];
  if (e.cwd) meta.push("cwd `" + e.cwd + "`");
  if (e.at) meta.push(fmtTime(e.at));
  if (e.dur != null && e.dur > 0) meta.push("took " + fmtDur(e.dur));
  if (e.exit) meta.push("exit " + e.exit);
  if (meta.length) L.push("*" + meta.join(" · ") + "*", "");
  if (e.output && e.output.trim()) { L.push("```"); L.push(e.output.replace(/\s+$/, "")); L.push("```", ""); }
  return L.join("\n").trimEnd() + "\n";
}
