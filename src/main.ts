import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from "obsidian";
import { parseSession, DEFAULT_PROMPT_RE, DEFAULT_CWD_RE, type CommandEntry, type ParsedSession } from "./parser";
import { commandMarkdown, commandNote, indexNote, sessionTitle, slugFile, uniqueName, fmtTime, fmtDur } from "./notes";

interface LogLadySettings {
  promptRe: string;
  cwdRe: string;
  defaultFolder: string;
  defaultMode: "insert" | "notes";
}

const DEFAULT_SETTINGS: LogLadySettings = {
  promptRe: DEFAULT_PROMPT_RE,
  cwdRe: DEFAULT_CWD_RE,
  defaultFolder: "LogLady",
  defaultMode: "notes",
};

// A parsed session tagged with which UI rows are currently checked, so the
// modal doesn't have to re-derive selection from the DOM.
interface CatalogSession extends ParsedSession {
  selected: Set<CommandEntry>;
}

function baseKey(name: string): string {
  return name.replace(/_(shell|time)\.log$/i, "").replace(/\.(log|txt)$/i, "");
}

export default class LogLadyPlugin extends Plugin {
  settings: LogLadySettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();
    this.addCommand({
      id: "import-script-session",
      name: "Import script(1) session…",
      callback: () => new ImportModal(this.app, this).open(),
    });
    this.addSettingTab(new LogLadySettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class LogLadySettingTab extends PluginSettingTab {
  plugin: LogLadyPlugin;
  constructor(app: App, plugin: LogLadyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "LogLady" });

    new Setting(containerEl)
      .setName("Command prompt regex")
      .setDesc("JS regex matched against each reconstructed line; group 1 is the command text. Default matches the Kali continuation prompt.")
      .addText(t => t
        .setValue(this.plugin.settings.promptRe)
        .onChange(async v => { this.plugin.settings.promptRe = v || DEFAULT_PROMPT_RE; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Working-directory regex")
      .setDesc("Optional JS regex; group 1 is the working directory shown in a two-line prompt banner.")
      .addText(t => t
        .setValue(this.plugin.settings.cwdRe)
        .onChange(async v => { this.plugin.settings.cwdRe = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Default notes folder")
      .setDesc("Where \"Create linked notes\" writes by default (created if it doesn't exist).")
      .addText(t => t
        .setValue(this.plugin.settings.defaultFolder)
        .onChange(async v => { this.plugin.settings.defaultFolder = v || DEFAULT_SETTINGS.defaultFolder; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Default import mode")
      .addDropdown(d => d
        .addOption("notes", "Create linked notes")
        .addOption("insert", "Insert at cursor")
        .setValue(this.plugin.settings.defaultMode)
        .onChange(async v => { this.plugin.settings.defaultMode = v as "insert" | "notes"; await this.plugin.saveSettings(); }));
  }
}

class ImportModal extends Modal {
  plugin: LogLadyPlugin;
  sessions: CatalogSession[] = [];
  filter = "";
  mode: "insert" | "notes";
  folder: string;

  catalogEl!: HTMLElement;
  countEl!: HTMLElement;
  importBtn!: HTMLButtonElement;
  folderRow!: HTMLElement;

  constructor(app: App, plugin: LogLadyPlugin) {
    super(app);
    this.plugin = plugin;
    this.mode = plugin.settings.defaultMode;
    this.folder = plugin.settings.defaultFolder;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("loglady-modal");
    contentEl.createEl("h2", { text: "Import script(1) session" });

    const drop = contentEl.createDiv({ cls: "loglady-drop" });
    drop.createEl("b", { text: "Drop shell & time logs here" });
    drop.createEl("br");
    const pick = drop.createEl("a", { text: "or choose files", href: "#" });
    drop.createEl("br");
    drop.createSpan({ text: "*_shell.log required · *_time.log optional (adds timestamps)", cls: "loglady-hint" });
    const fileInput = contentEl.createEl("input", { type: "file", attr: { multiple: true, accept: ".log,text/plain" } });
    fileInput.style.display = "none";

    pick.addEventListener("click", e => { e.preventDefault(); fileInput.click(); });
    fileInput.addEventListener("change", () => { if (fileInput.files) this.ingest(fileInput.files); fileInput.value = ""; });
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.addClass("hot"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.removeClass("hot"); }));
    drop.addEventListener("drop", e => { if (e.dataTransfer?.files.length) this.ingest(e.dataTransfer.files); });

    const searchRow = contentEl.createDiv({ cls: "loglady-row" });
    const search = searchRow.createEl("input", { type: "text", attr: { placeholder: "Filter commands…" } });
    search.addEventListener("input", () => { this.filter = search.value; this.renderCatalog(); });
    const selAllBtn = searchRow.createEl("button", { text: "Select all shown" });
    selAllBtn.addEventListener("click", () => this.selectAllShown());

    this.catalogEl = contentEl.createDiv({ cls: "loglady-catalog" });
    this.renderCatalog();

    const modeRow = contentEl.createDiv({ cls: "loglady-row" });
    this.countEl = modeRow.createSpan({ cls: "loglady-count" });
    const modeSel = modeRow.createEl("select");
    modeSel.createEl("option", { text: "Create linked notes", value: "notes" });
    modeSel.createEl("option", { text: "Insert at cursor", value: "insert" });
    modeSel.value = this.mode;
    modeSel.addEventListener("change", () => { this.mode = modeSel.value as "insert" | "notes"; this.updateFolderVisibility(); });

    this.folderRow = contentEl.createDiv({ cls: "loglady-row" });
    this.folderRow.createSpan({ text: "Folder:" });
    const folderInput = this.folderRow.createEl("input", { type: "text" });
    folderInput.value = this.folder;
    folderInput.addEventListener("input", () => { this.folder = folderInput.value; });
    this.updateFolderVisibility();

    const footer = contentEl.createDiv({ cls: "loglady-footer" });
    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    this.importBtn = footer.createEl("button", { text: "Import", cls: "mod-cta" });
    this.importBtn.disabled = true;
    this.importBtn.addEventListener("click", () => this.runImport());

    this.updateCount();
  }

  updateFolderVisibility() {
    this.folderRow.style.display = this.mode === "notes" ? "" : "none";
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
      this.sessions.push({ ...parsed, selected: new Set() });
      added++;
    }
    if (added) new Notice(`Loaded ${added} session${added > 1 ? "s" : ""}`);
    else new Notice("No *_shell.log files found in the selection");
    this.renderCatalog();
  }

  visibleEntries(sess: CatalogSession): CommandEntry[] {
    const f = this.filter.toLowerCase();
    return sess.entries.filter(e => {
      if (e.noise && !sess.selected.has(e)) return false;
      if (f && !(e.command.toLowerCase().includes(f) || e.output.toLowerCase().includes(f))) return false;
      return true;
    });
  }

  selectAllShown() {
    for (const sess of this.sessions) for (const e of this.visibleEntries(sess)) sess.selected.add(e);
    this.renderCatalog();
  }

  totalSelected(): number {
    return this.sessions.reduce((n, s) => n + s.selected.size, 0);
  }

  updateCount() {
    const n = this.totalSelected();
    this.countEl.setText(n ? `${n} command${n > 1 ? "s" : ""} selected` : "");
    this.importBtn.disabled = n === 0;
  }

  renderCatalog() {
    this.catalogEl.empty();
    if (!this.sessions.length) {
      this.catalogEl.createDiv({ cls: "loglady-hint", text: "Drop shell + time logs above to list their commands." });
      this.updateCount();
      return;
    }
    for (const sess of this.sessions) {
      const shown = this.visibleEntries(sess);
      if (!shown.length) continue;
      this.catalogEl.createDiv({ cls: "loglady-sess-head", text: sessionTitle(sess.name, sess.startEpoch) + ` (${sess.selected.size}/${sess.entries.length})` });
      for (const e of shown) {
        const row = this.catalogEl.createDiv({ cls: "loglady-cmd" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = sess.selected.has(e);
        cb.addEventListener("click", ev => ev.stopPropagation());
        cb.addEventListener("change", () => { if (cb.checked) sess.selected.add(e); else sess.selected.delete(e); this.updateCount(); });
        row.createSpan({ cls: "txt", text: e.command || "(blank line)" });
        if (e.at) row.createSpan({ cls: "b", text: fmtTime(e.at) });
        row.addEventListener("click", () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); });
      }
    }
    this.updateCount();
  }

  async runImport() {
    const picks: { sess: CatalogSession; e: CommandEntry }[] = [];
    for (const sess of this.sessions) for (const e of sess.entries) if (sess.selected.has(e)) picks.push({ sess, e });
    if (!picks.length) return;

    if (this.mode === "insert") {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) { new Notice("Open a note first, then Insert at cursor."); return; }
      const md = picks.map(p => commandMarkdown(p.e)).join("\n").replace(/\n{3,}/g, "\n\n");
      view.editor.replaceSelection(md);
      new Notice(`Inserted ${picks.length} command${picks.length > 1 ? "s" : ""}`);
      this.close();
      return;
    }

    // Create linked notes: one index note per session (only for sessions with
    // at least one pick), one note per picked command.
    const folder = normalizePath(this.folder || DEFAULT_SETTINGS.defaultFolder);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder).catch(() => {});
    }
    const used = new Set<string>();
    const bySession = new Map<CatalogSession, { e: CommandEntry }[]>();
    for (const p of picks) {
      if (!bySession.has(p.sess)) bySession.set(p.sess, []);
      bySession.get(p.sess)!.push({ e: p.e });
    }

    let noteCount = 0;
    for (const [sess, items] of bySession) {
      const title = sessionTitle(sess.name, sess.startEpoch);
      const indexName = uniqueName(slugFile(title, 50), used);
      const linked: { name: string }[] = [];
      for (const { e } of items) {
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
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
