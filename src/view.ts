import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { parseSession, type CommandEntry, type ParsedSession } from "./parser";
import { commandMarkdown, sessionTitle, fmtTime, fmtDur } from "./notes";
import type LogLadyPlugin from "./main";

export const VIEW_TYPE_LOGLADY = "loglady-panel";

function baseKey(name: string): string {
  return name.replace(/_(shell|time)\.log$/i, "").replace(/\.(log|txt)$/i, "");
}

/** FNV-1a (32-bit), enough to fingerprint a log for re-import detection. */
function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** A load signature: same name, byte length, shell content, and timing → same import. */
function sessionSig(name: string, bytes: Uint8Array, timeText: string | null): string {
  const t = timeText ? fnv1a32(new TextEncoder().encode(timeText)).toString(16) : "0";
  return `${name}|${bytes.length}|${fnv1a32(bytes).toString(16)}|${t}`;
}

/**
 * Persistent left-sidebar pane: drop or pick script(1) logs, search the
 * reconstructed commands, peek a command's captured output, and drag any row
 * straight onto an open note — Obsidian's editor accepts the plain-text drop at
 * the cursor position, so nothing needs to be selected first.
 */
export class LogLadyView extends ItemView {
  plugin: LogLadyPlugin;
  sessions: ParsedSession[] = [];
  filter = "";
  hideNoise = true;
  /** Entries whose output preview is expanded; keyed by identity so it survives re-render. */
  peeked = new Set<CommandEntry>();
  /** Signatures of already-loaded sessions, so re-importing the same log is skipped. */
  loaded = new Set<string>();

  catalogEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LogLadyPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_LOGLADY; }
  getDisplayText() { return "LogLady"; }
  getIcon() { return "terminal"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("loglady-pane");

    const drop = root.createDiv({ cls: "loglady-drop" });
    drop.createEl("b", { text: "Drop shell & time logs" });
    drop.createEl("br");
    const pick = drop.createEl("a", { text: "or choose files", href: "#" });
    const fileInput = root.createEl("input", { cls: "loglady-hidden", type: "file", attr: { multiple: true, accept: ".log,text/plain" } });
    pick.addEventListener("click", e => { e.preventDefault(); fileInput.click(); });
    fileInput.addEventListener("change", () => { if (fileInput.files) this.ingest(fileInput.files); fileInput.value = ""; });
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.addClass("hot"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.removeClass("hot"); }));
    drop.addEventListener("drop", e => { if (e.dataTransfer?.files.length) this.ingest(e.dataTransfer.files); });

    const searchRow = root.createDiv({ cls: "loglady-row" });
    const search = searchRow.createEl("input", { type: "text", attr: { placeholder: "Filter…" } });
    search.addEventListener("input", () => { this.filter = search.value; this.renderCatalog(); });
    const toolsRow = root.createDiv({ cls: "loglady-row" });
    const hideNoiseLbl = toolsRow.createEl("label", { cls: "loglady-check" });
    const hideNoiseCb = hideNoiseLbl.createEl("input", { type: "checkbox" });
    hideNoiseCb.checked = this.hideNoise;
    hideNoiseLbl.createSpan({ text: "hide noise" });
    hideNoiseCb.addEventListener("change", () => { this.hideNoise = hideNoiseCb.checked; this.renderCatalog(); });

    this.catalogEl = root.createDiv({ cls: "loglady-catalog" });
    this.renderCatalog();

    root.createDiv({ cls: "loglady-hint loglady-foot", text: "Drag a command onto a note to insert it." });
  }

  async onClose() {
    this.contentEl.empty();
  }

  async ingest(fileList: FileList) {
    const files = Array.from(fileList);
    const read = await Promise.all(files.map(async f => {
      const isTime = /_time\.log$/i.test(f.name);
      if (isTime) return { name: f.name, kind: "time" as const, text: await f.text() };
      return { name: f.name, kind: "shell" as const, bytes: new Uint8Array(await f.arrayBuffer()) };
    }));
    const groups: Record<string, { shell?: typeof read[number]; time?: typeof read[number] }> = {};
    for (const r of read) {
      const k = baseKey(r.name);
      (groups[k] = groups[k] || {})[r.kind] = r;
    }
    let added = 0, skipped = 0;
    for (const k of Object.keys(groups).sort()) {
      const g = groups[k];
      if (!g.shell || g.shell.kind !== "shell") continue;
      const timeText = g.time?.kind === "time" ? g.time.text : null;
      const sig = sessionSig(g.shell.name, g.shell.bytes, timeText);
      if (this.loaded.has(sig)) { skipped++; continue; } // identical log already loaded
      this.loaded.add(sig);
      this.sessions.push(parseSession(g.shell.name, g.shell.bytes, timeText, this.plugin.settings.promptRe, this.plugin.settings.cwdRe, this.plugin.settings.assumedWidth));
      added++;
    }
    if (added && skipped) new Notice(`Loaded ${added} session${added > 1 ? "s" : ""}; skipped ${skipped} already loaded`);
    else if (added) new Notice(`Loaded ${added} session${added > 1 ? "s" : ""}`);
    else if (skipped) new Notice(`Already loaded — skipped ${skipped} session${skipped > 1 ? "s" : ""}`);
    else new Notice("No *_shell.log files found in the selection");
    this.renderCatalog();
  }

  visibleEntries(sess: ParsedSession): CommandEntry[] {
    const f = this.filter.toLowerCase();
    return sess.entries.filter(e => {
      if (this.hideNoise && e.noise) return false;
      if (f && !(e.command.toLowerCase().includes(f) || e.output.toLowerCase().includes(f))) return false;
      return true;
    });
  }

  /**
   * One command row: draggable onto a note, with a ▸ button that expands the
   * command's reconstructed output underneath it.
   */
  private renderRow(container: HTMLElement, e: CommandEntry) {
    const row = container.createDiv({ cls: "loglady-cmd" });
    row.setAttr("draggable", "true");
    row.createSpan({ cls: "txt", text: e.command || "(blank line)" });
    if (e.at) row.createSpan({ cls: "b", text: fmtTime(e.at) });

    const open = this.peeked.has(e);
    const peekBtn = row.createEl("button", { cls: "loglady-icon" + (e.empty ? " faint" : ""), text: open ? "▾" : "▸" });
    peekBtn.setAttr("aria-label", open ? "Hide output" : "Peek output");
    peekBtn.title = e.empty ? "No output captured" : "Peek this command's output";
    peekBtn.addEventListener("click", ev => {
      ev.stopPropagation();
      if (open) this.peeked.delete(e); else this.peeked.add(e);
      this.renderCatalog();
    });

    row.title = "Drag onto a note to insert";
    row.addEventListener("dragstart", ev => {
      ev.dataTransfer?.setData("text/plain", commandMarkdown(e));
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
      row.addClass("dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("dragging"));

    if (open) this.renderPeek(container, e);
  }

  /** The expanded output preview: cwd/duration/exit line plus the reconstructed output text. */
  private renderPeek(container: HTMLElement, e: CommandEntry) {
    const peek = container.createDiv({ cls: "loglady-peek" });
    const meta: string[] = [];
    if (e.cwd) meta.push(e.cwd);
    if (e.dur != null && e.dur > 0) meta.push("took " + fmtDur(e.dur));
    if (e.exit != null) meta.push("exit " + e.exit);
    if (meta.length) peek.createDiv({ cls: "loglady-peek-meta", text: meta.join(" · ") });
    if (e.output.trim()) peek.createEl("pre", { text: e.output });
    else peek.createDiv({ cls: "loglady-hint", text: "No output captured for this command." });
  }

  renderCatalog() {
    const top = this.catalogEl.scrollTop; // peek toggles repaint; keep the pane still
    this.catalogEl.empty();
    if (!this.sessions.length) {
      this.catalogEl.createDiv({ cls: "loglady-hint", text: "No logs loaded yet." });
      return;
    }
    let anyShown = false;
    for (const sess of this.sessions) {
      const shown = this.visibleEntries(sess);
      if (!shown.length) continue;
      anyShown = true;
      this.catalogEl.createDiv({
        cls: "loglady-sess-head",
        text: sessionTitle(sess.name, sess.startEpoch) + ` (${sess.entries.length})`,
      });
      for (const e of shown) this.renderRow(this.catalogEl, e);
    }
    if (!anyShown) this.catalogEl.createDiv({ cls: "loglady-hint", text: this.filter ? "No commands match your filter." : "Nothing to show." });
    this.catalogEl.scrollTop = top;
  }
}
