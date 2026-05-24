import { App, PluginSettingTab, Setting } from "obsidian";
import type GitHubSyncPlugin from "./main";

export interface GitHubSyncSettings {
    token: string;
    repository: string;   // 格式: owner/repo
    branch: string;
    ignorePaths: string;  // 每行一个路径
    commitMessage: string;
}

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
    token: '',
    repository: '',
    branch: 'main',
    ignorePaths: '.obsidian/workspace.json',
    commitMessage: 'obsidian sync {date}',
};

export class GitHubSyncSettingTab extends PluginSettingTab {
    plugin: GitHubSyncPlugin;

    constructor(app: App, plugin: GitHubSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('github-sync-settings');

        new Setting(containerEl)
            .setName('GitHub Token')
            .setDesc('你的 GitHub Personal Access Token')
            .addText(text => text
                .setPlaceholder('ghp_xxxx')
                .setValue(this.plugin.settings.token)
                .onChange(async (value) => {
                    this.plugin.settings.token = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('仓库')
            .setDesc('格式: 用户名/仓库名，例如 myname/obsidian-notes')
            .addText(text => text
                .setPlaceholder('your-username/your-repo')
                .setValue(this.plugin.settings.repository)
                .onChange(async (value) => {
                    this.plugin.settings.repository = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('分支')
            .setDesc('默认 main')
            .addText(text => text
                .setPlaceholder('main')
                .setValue(this.plugin.settings.branch)
                .onChange(async (value) => {
                    this.plugin.settings.branch = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('忽略路径')
            .setDesc('每行一个路径，例如 .obsidian/workspace.json')
            .addTextArea(text => text
                .setPlaceholder('.obsidian/workspace.json')
                .setValue(this.plugin.settings.ignorePaths)
                .onChange(async (value) => {
                    this.plugin.settings.ignorePaths = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('提交信息')
            .setDesc('{date} 会被替换为当前时间')
            .addText(text => text
                .setPlaceholder('obsidian sync {date}')
                .setValue(this.plugin.settings.commitMessage)
                .onChange(async (value) => {
                    this.plugin.settings.commitMessage = value;
                    await this.plugin.saveSettings();
                }));
    }
}