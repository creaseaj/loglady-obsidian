import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { DEFAULT_PROMPT_RE, DEFAULT_CWD_RE } from "./parser";
import { LogLadyView, VIEW_TYPE_LOGLADY } from "./view";

interface LogLadySettings {
  promptRe: string;
  cwdRe: string;
  defaultFolder: string;
}

const DEFAULT_SETTINGS: LogLadySettings = {
  promptRe: DEFAULT_PROMPT_RE,
  cwdRe: DEFAULT_CWD_RE,
  defaultFolder: "LogLady",
};

export default class LogLadyPlugin extends Plugin {
  settings: LogLadySettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_LOGLADY, leaf => new LogLadyView(leaf, this));
    this.addRibbonIcon("terminal", "Open LogLady panel", () => this.activateView());
    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => this.activateView(),
    });
    this.addSettingTab(new LogLadySettingTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_LOGLADY)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeftLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_LOGLADY, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
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
      .setDesc("Where \"Create notes\" writes by default in the panel (created if it doesn't exist). The panel's own Folder field can override this per-import.")
      .addText(t => t
        .setValue(this.plugin.settings.defaultFolder)
        .onChange(async v => { this.plugin.settings.defaultFolder = v || DEFAULT_SETTINGS.defaultFolder; await this.plugin.saveSettings(); }));
  }
}
