import { ItemView, MarkdownView, Notice, WorkspaceLeaf, normalizePath } from "obsidian";
import { parseSession, type CommandEntry, type ParsedSession } from "./parser";
import { commandMarkdown, commandNote, indexNote, sessionTitle, slugFile, uniqueName, fmtTime } from "./notes";
import type LogLadyPlugin from "./main";

export const VIEW_TYPE_LOGLADY = "loglady-panel";

interface CatalogSession extends ParsedSession {
  banked: Set<CommandEntry>;
}

function baseKey(name: string): string {
  return name.replace(/_(shell|time)\.log$/i, "").replace(/\.(log|txt)$/i, "");
}

/**
 * Persistent left-sidebar pane: drop/pick script(1) logs, search the
 * reconstructed commands, and either drag a row straight into an open note
 * (native HTML5 drag — Obsidian's editor accepts a plain-text drop at the
 * cursor position) or click rows to build up a "banked" selection acted on
 * in bulk via the footer buttons. Mirrors loglady.html's catalog/bank model.
 */
export class LogLadyView extends ItemView {
  plugin: LogLadyPlugin;
  sessions: CatalogSession[] = [];
  filter = "";
  hideNoise = true;

  catalogEl!: HTMLElement;
  countEl!: HTMLElement;
  insertBtn!: HTMLButtonElement;
  createBtn!: HTMLButtonElement;
  folderInput!: HTMLInputElement;

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
    const fileInput = root.createEl("input", { type: "file", attr: { multiple: true, accept: ".log,text/plain" } });
    fileInput.style.display = "none";
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
    const selAllBtn = toolsRow.createEl("button", { text: "Select all shown", cls: "loglady-mini" });
    selAllBtn.addEventListener("click", () => this.selectAllShown());

    this.catalogEl = root.createDiv({ cls: "loglady-catalog" });
    this.renderCatalog();

    const folderRow = root.createDiv({ cls: "loglady-row" });
    folderRow.createSpan({ text: "Folder:", cls: "loglady-hint" });
    this.folderInput = folderRow.createEl("input", { type: "text" });
    this.folderInput.value = this.plugin.settings.defaultFolder;

    this.countEl = root.createDiv({ cls: "loglady-count" });

    const footer = root.createDiv({ cls: "loglady-footer" });
    this.insertBtn = footer.createEl("button", { text: "Insert at cursor" });
    this.insertBtn.addEventListener("click", () => this.insertBankedAtCursor());
    this.createBtn = footer.createEl("button", { text: "Create notes", cls: "mod-cta" });
    this.createBtn.addEventListener("click", () => this.createBankedNotes());
    const clearBtn = footer.createEl("button", { text: "Clear", cls: "loglady-mini" });
    clearBtn.addEventListener("click", () => this.clearBank());

    this.updateCount();
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
    let added = 0;
    for (const k of Object.keys(groups).sort()) {
      const g = groups[k];
      if (!g.shell || g.shell.kind !== "shell") continue;
      const parsed = parseSession(g.shell.name, g.shell.bytes, g.time?.kind === "time" ? g.time.text : null, this.plugin.settings.promptRe, this.plugin.settings.cwdRe);
      this.sessions.push({ ...parsed, banked: new Set() });
      added++;
    }
    if (added) new Notice(`Loaded ${added} session${added > 1 ? "s" : ""}`);
    else new Notice("No *_shell.log files found in the selection");
    this.renderCatalog();
  }

  visibleEntries(sess: CatalogSession): CommandEntry[] {
    const f = this.filter.toLowerCase();
    return sess.entries.filter(e => {
      if (this.hideNoise && e.noise && !sess.banked.has(e)) return false;
      if (f && !(e.command.toLowerCase().includes(f) || e.output.toLowerCase().includes(f))) return false;
      return true;
    });
  }

  selectAllShown() {
    for (const sess of this.sessions) for (const e of this.visibleEntries(sess)) sess.banked.add(e);
    this.renderCatalog();
  }

  clearBank() {
    for (const sess of this.sessions) sess.banked.clear();
    this.renderCatalog();
  }

  totalBanked(): number {
    return this.sessions.reduce((n, s) => n + s.banked.size, 0);
  }

  updateCount() {
    const n = this.totalBanked();
    this.countEl.setText(n ? `${n} banked` : "Click to bank, or drag a row into a note");
    this.insertBtn.disabled = n === 0;
    this.createBtn.disabled = n === 0;
  }

  renderCatalog() {
    this.catalogEl.empty();
    if (!this.sessions.length) {
      this.catalogEl.createDiv({ cls: "loglady-hint", text: "No logs loaded yet." });
      this.updateCount();
      return;
    }
    let anyShown = false;
    for (const sess of this.sessions) {
      const shown = this.visibleEntries(sess);
      if (!shown.length) continue;
      anyShown = true;
      this.catalogEl.createDiv({
        cls: "loglady-sess-head",
        text: sessionTitle(sess.name, sess.startEpoch) + ` (${sess.banked.size}/${sess.entries.length})`,
      });
      for (const e of shown) {
        const row = this.catalogEl.createDiv({ cls: "loglady-cmd" + (sess.banked.has(e) ? " banked" : "") });
        row.setAttr("draggable", "true");
        row.createSpan({ cls: "mark", text: sess.banked.has(e) ? "✓" : "+" });
        row.createSpan({ cls: "txt", text: e.command || "(blank line)" });
        if (e.at) row.createSpan({ cls: "b", text: fmtTime(e.at) });
        row.title = "Click to bank · drag onto a note to insert";

        row.addEventListener("click", () => {
          if (sess.banked.has(e)) sess.banked.delete(e); else sess.banked.add(e);
          this.renderCatalog();
        });
        row.addEventListener("dragstart", ev => {
          ev.dataTransfer?.setData("text/plain", commandMarkdown(e));
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
          row.addClass("dragging");
        });
        row.addEventListener("dragend", () => row.removeClass("dragging"));
      }
    }
    if (!anyShown) this.catalogEl.createDiv({ cls: "loglady-hint", text: this.filter ? "No commands match your filter." : "Nothing to show." });
    this.updateCount();
  }

  private pickedEntries(): { sess: CatalogSession; e: CommandEntry }[] {
    const picks: { sess: CatalogSession; e: CommandEntry }[] = [];
    for (const sess of this.sessions) for (const e of sess.entries) if (sess.banked.has(e)) picks.push({ sess, e });
    return picks;
  }

  insertBankedAtCursor() {
    const picks = this.pickedEntries();
    if (!picks.length) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice("Open a note first, then Insert at cursor."); return; }
    const md = picks.map(p => commandMarkdown(p.e)).join("\n").replace(/\n{3,}/g, "\n\n");
    view.editor.replaceSelection(md);
    new Notice(`Inserted ${picks.length} command${picks.length > 1 ? "s" : ""}`);
  }

  async createBankedNotes() {
    const picks = this.pickedEntries();
    if (!picks.length) return;
    const folder = normalizePath(this.folderInput.value || this.plugin.settings.defaultFolder);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder).catch(() => {});
    }
    const used = new Set<string>();
    const bySession = new Map<CatalogSession, CommandEntry[]>();
    for (const p of picks) {
      if (!bySession.has(p.sess)) bySession.set(p.sess, []);
      bySession.get(p.sess)!.push(p.e);
    }
    let noteCount = 0;
    for (const [sess, entries] of bySession) {
      const title = sessionTitle(sess.name, sess.startEpoch);
      const indexName = uniqueName(slugFile(title, 50), used);
      const linked: { name: string }[] = [];
      for (const e of entries) {
        const noteName = uniqueName(slugFile(e.command || "command", 40), used);
        const path = normalizePath(`${folder}/${noteName}.md`);
        await this.app.vault.create(path, commandNote(e, title, indexName)).catch(() => {
          new Notice(`Skipped ${noteName}.md (already exists?)`);
        });
        linked.push({ name: noteName });
        noteCount++;
      }
      const indexPath = normalizePath(`${folder}/${indexName}.md`);
      await this.app.vault.create(indexPath, indexNote(title, linked)).catch(() => {
        new Notice(`Skipped ${indexName}.md (already exists?)`);
      });
    }
    new Notice(`Created ${noteCount} note${noteCount > 1 ? "s" : ""} in ${folder}/`);
  }
}
