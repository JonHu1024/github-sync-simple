// main.ts — GitHub Sync 插件入口

import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { GitHubClient, GitHubFile } from "./github";
import { computeDiff, DiffResult, FileDiff } from "./diff";
import {
	ConfirmSyncModal,
	ProgressModal,
	SyncMode,
	SyncModeModal,
	UnsyncedWarningModal,
} from "./modals";
import {
	DEFAULT_SETTINGS,
	GitHubSyncSettings,
	GitHubSyncSettingTab,
} from "./settings";

interface LocalFileSnapshot {
	files: Map<string, ArrayBuffer>;
	mtimes: Map<string, number>;
}

interface SmartSyncPlan {
	uploads: FileDiff[];
	downloads: FileDiff[];
	previewItems: FileDiff[];
	unchanged: number;
}

export default class GitHubSyncPlugin extends Plugin {
	settings!: GitHubSyncSettings;
	private isSyncing = false;
	private isDirty = false; // 最终是否有未同步的修改
	private statusBarEl!: HTMLElement; // 状态栏元素
	// 新增：用于记录未同步文件和防抖保存
	private unsyncedPaths = new Set<string>();
	private saveStateTimer: number | null = null;
	private recentlySyncedPaths = new Set<string>();// 冷却池：防止同步写入触发的 modify 被误判

	async onload() {
		await this.loadSettings();

		// 正常用户不可能一次退出前手动改了 10 个以上的文件还没同步。如果超过 10 个，绝对是之前启动风暴导致的脏数据，直接清空！
		if (this.settings.lastUnsyncedPaths && this.settings.lastUnsyncedPaths.length > 10) {
			this.settings.lastUnsyncedPaths = [];
			this.settings.hasUnsyncedChanges = false;
			await this.saveSettings();
		}

		// 恢复内存中的未同步集合
		if (this.settings.hasUnsyncedChanges) {
			this.isDirty = true;
			this.settings.lastUnsyncedPaths.forEach(p => this.unsyncedPaths.add(p));
		}

		//初始化状态栏
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar();

		// 左侧边栏图标
		this.addRibbonIcon("github", "GitHub Sync", () => {
			this.openSyncModal();
		});

		// 命令面板
		this.addCommand({
			id: "open-sync-modal",
			name: "打开同步对话框",
			callback: () => this.openSyncModal(),
		});

		this.addCommand({
			id: "quick-push",
			name: "Quick Push(直接显示差异确认)",
			callback: () => this.startSync("push"),
		});

		this.addCommand({
			id: "quick-pull",
			name: "Quick Pull(直接显示差异确认)",
			callback: () => this.startSync("pull"),
		});

		this.addCommand({
			id: "quick-smart",
			name: "快速智能同步(按修改时间自动决定方向)",
			callback: () => this.startSync("smart"),
		});

		// 设置选项卡
		this.addSettingTab(new GitHubSyncSettingTab(this.app, this));

		// 注入样式
		this.injectStyles();

		//等待 Obsidian 完全启动、UI 渲染完毕后，再注册监听
		this.app.workspace.onLayoutReady(() => {
			let isBooting = true;
			// 5秒免疫期：防止其他插件在启动后异步写入配置文件
			setTimeout(() => { isBooting = false; }, 5000);

			const markDirty = (file: TAbstractFile) => {
				if (isBooting) return; // 免疫期内无视一切
				if (this.isSyncing) return;
				if (!(file instanceof TFile)) return;
				
				// 硬编码无视 .obsidian 目录
				// 用户的笔记修改才需要提醒，配置文件的变动不应污染“未同步名单”
				if (file.path.startsWith('.obsidian/') || file.path === '.obsidian') return;
				
				if (this.recentlySyncedPaths.has(file.path)) return;

				this.unsyncedPaths.add(file.path);
				this.setDirty(true);
				this.debounceSaveState();
			};
			this.registerEvent(this.app.vault.on("modify", markDirty));
			this.registerEvent(this.app.vault.on("create", markDirty));
			this.registerEvent(this.app.vault.on("delete", markDirty));
			this.registerEvent(this.app.vault.on("rename", (file) => {
				if (file instanceof TFile) markDirty(file);
			}));
			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (file instanceof TFile) {
						menu.addSeparator();
						menu.addItem((item) => {
							item
								.setTitle("Push To GitHub")
								.setIcon("arrow-up-circle")
								.onClick(() => this.startSync("push", file.path));
						});
						menu.addItem((item) => {
							item
								.setTitle("Pull From GitHub")
								.setIcon("arrow-down-circle")
								.onClick(() => this.startSync("pull", file.path));
						});
						menu.addItem((item) => {
							item
								.setTitle("Smart Push/Pull")
								.setIcon("refresh-cw")
								.onClick(() => this.startSync("smart", file.path));
						});
					}
				})
			);
		});

		// 新增：启动时检查并弹出警告
		if (this.settings.showUnsyncedWarningOnStartup && this.settings.hasUnsyncedChanges) {
			setTimeout(() => {
				new UnsyncedWarningModal(
					this.app,
					this.settings.lastUnsyncedPaths || [],
					() => this.openSyncModal()
				).open();
			}, 800);//延迟0.8s防止与启动动画冲突
		}
	}

	onunload() {
		const style = document.getElementById("github-sync-styles");
		if (style) style.remove();
	}

	// 新增：防抖保存状态到 data.json (5秒内无新修改才写入，避免卡顿)
	private debounceSaveState() {
		if (this.saveStateTimer) window.clearTimeout(this.saveStateTimer);
		this.saveStateTimer = window.setTimeout(async () => {
			this.settings.hasUnsyncedChanges = this.isDirty;
			this.settings.lastUnsyncedPaths = Array.from(this.unsyncedPaths);
			await this.saveSettings();
		}, 5*1000);
	}

	// 新增：彻底清理未同步状态（同步成功后调用）
	private async clearDirtyState() {
		this.isDirty = false;
		this.unsyncedPaths.clear();
		this.settings.hasUnsyncedChanges = false;
		this.settings.lastUnsyncedPaths = [];
		if (this.saveStateTimer) window.clearTimeout(this.saveStateTimer);
		await this.saveSettings(); // 立即保存
		this.updateStatusBar();
	}

	// 修改原有的 setDirty，使其与持久化状态同步
	private setDirty(dirty: boolean) {
		if (this.isDirty !== dirty) {
			this.isDirty = dirty;
			this.updateStatusBar();
			// 如果变为 false，也触发一次保存（清理记录）
			if (!dirty) this.debounceSaveState();
		}
	}

	// 新增：更新状态栏 UI
	private updateStatusBar() {
		if (this.isDirty) {
			this.statusBarEl.setText("⚠️GitHub未同步");
			this.statusBarEl.style.color = "var(--text-warning, #e6922a)";
			this.statusBarEl.style.cursor = "pointer";
			this.statusBarEl.title = "点击立即同步";
			this.statusBarEl.onclick = () => this.openSyncModal();
		} else {
			this.statusBarEl.setText("✅GitHub已同步");
			this.statusBarEl.style.color = "var(--text-success, #28a745)";
			this.statusBarEl.style.cursor = "default";
			this.statusBarEl.title = "";
			this.statusBarEl.onclick = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ──────────────────────────────────────────────
	// 同步入口
	// ──────────────────────────────────────────────

	private openSyncModal() {
		if (!this.checkConfig()) return;
		new SyncModeModal(this.app, (mode) => this.startSync(mode)).open();
	}

	async startSync(mode: SyncMode, targetPath?: string) {
		if (!this.checkConfig()) return;

		if (this.isSyncing) {
			new Notice("正在同步...(点击屏幕空白区域可以后台运行同步)");
			return;
		}

		const progress = new ProgressModal(this.app);
		progress.open();

		try {
			const { token, repository, branch, ignorePaths } = this.settings;
			const ignore = ignorePaths
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);

			const client = new GitHubClient(token, repository, branch);

			// 1. 读取本地文件
			progress.setMessage(targetPath ? `读取 ${targetPath}...` : "读取本地 Vault 文件...");
			const local = await this.readLocalFiles(ignore);

			// 2. 读取远端文件列表
			progress.setMessage("获取 GitHub 文件列表...");
			const remote = await client.listAllFiles();

			// 3. 计算差异
			progress.setMessage("计算差异...");
			let diff = await computeDiff(local.files, remote.files, ignore);

			// 新增：如果没有差异，说明已经是最新，重置 Dirty 状态
			const hasChanges =
				diff.toUpload.length > 0 ||
				diff.toDelete.length > 0 ||
				diff.toDownload.length > 0 ||
				diff.toRemove.length > 0;

			if (targetPath) {
				diff = {
					toUpload: diff.toUpload.filter((f) => f.path === targetPath),
					toDelete: diff.toDelete.filter((f) => f.path === targetPath),
					toDownload: diff.toDownload.filter((f) => f.path === targetPath),
					toRemove: diff.toRemove.filter((f) => f.path === targetPath),
					unchanged: diff.unchanged.filter((f) => f.path === targetPath),
				};
			}

			if (!hasChanges && !targetPath) {
				this.setDirty(false);
			}

			// 4. 生成智能同步计划(如需要)
			let smartPlan: SmartSyncPlan | null = null;
			if (mode === "smart") {
				progress.setMessage("分析修改时间并生成智能同步计划...");
				smartPlan = await this.buildSmartSyncPlan(client, local, remote.files, diff);
			}

			progress.close();

			// 5. 弹出确认框
			if (mode === "push") {
				const toProcess = diff.toUpload;
				const toRemove = diff.toDelete;
				new ConfirmSyncModal(this.app, {
					mode: "push",
					toProcess,
					toRemove,
					unchanged: diff.unchanged.length,
					onConfirm: (selectedProcess, selectedRemove) =>
						this.executePush(
							client,
							local.files,
							remote.commitSha,
							remote.treeSha,
							selectedProcess,
							selectedRemove
						),
				}).open();
			} else if (mode === "pull") {
				const toProcess = diff.toDownload;
				const toRemove = diff.toRemove;
				new ConfirmSyncModal(this.app, {
					mode: "pull",
					toProcess,
					toRemove,
					unchanged: diff.unchanged.length,
					onConfirm: (selectedProcess, selectedRemove) =>
						this.executePull(client, selectedProcess, selectedRemove),
				}).open();
			} else {
				if (!smartPlan) throw new Error("智能同步计划生成失败");
				new ConfirmSyncModal(this.app, {
					mode: "smart",
					toProcess: smartPlan.previewItems,
					toRemove: [],
					unchanged: smartPlan.unchanged,
					onConfirm: (selectedProcess, selectedRemove) => {
						// 根据用户勾选的 previewItems，重新拆分出 uploads 和 downloads
						const uploads = selectedProcess.filter((f) => f.direction === "upload");
						const downloads = selectedProcess.filter((f) => f.direction === "download");
						return this.executeSmartSync(
							client,
							local.files,
							remote.commitSha,
							remote.treeSha,
							uploads,
							downloads
						);
					},
				}).open();
			}
		} catch (err) {
			progress.close();
			console.error("GitHub Sync error:", err);
			new Notice(`❌ 同步出错: ${this.getErrorMessage(err)}`);
		} finally {
			this.isSyncing = false;
		}
	}

	// ──────────────────────────────────────────────
	// 智能同步计划
	// ──────────────────────────────────────────────

	private async buildSmartSyncPlan(
		client: GitHubClient,
		local: LocalFileSnapshot,
		remoteFiles: GitHubFile[],
		diff: DiffResult
	): Promise<SmartSyncPlan> {
		const remoteMap = new Map(remoteFiles.map((f) => [f.path, f] as const));

		const uploads: FileDiff[] = [];
		const downloads: FileDiff[] = [];

		// 先处理本地独有文件：必然上传
		for (const item of diff.toUpload) {
			if (item.changeType === "added") {
				uploads.push({ ...item, direction: "upload" });
			}
		}

		// 远端独有文件：必然下载
		for (const item of diff.toDownload) {
			if (item.changeType === "added") {
				downloads.push({
					...item,
					direction: "download",
				});
			}
		}

		// 双方都存在但内容不同的文件：按修改时间决定方向
		const modifiedPaths = diff.toUpload
			.filter((item) => item.changeType === "modified")
			.map((item) => item.path);

		const remoteModTimes =
			modifiedPaths.length > 0
				? await client.getFileModTimes(modifiedPaths)
				: new Map<string, number>();

		for (const item of diff.toUpload) {
			if (item.changeType !== "modified") continue;

			const path = item.path;
			const localMtime = local.mtimes.get(path) ?? 0;
			const remoteMtime =
				remoteModTimes.get(path) ??
				remoteMap.get(path)?.remoteMtime ??
				0;

			const target = localMtime >= remoteMtime ? "upload" : "download";

			const enrichedItem: FileDiff = {
				...item,
				localMtime,
				remoteMtime,
				direction: target,
			};

			if (target === "upload") uploads.push(enrichedItem);
			else downloads.push(enrichedItem);
		}

		const previewItems = [...uploads, ...downloads].sort((a, b) =>
			a.path.localeCompare(b.path)
		);

		return {
			uploads,
			downloads,
			previewItems,
			unchanged: diff.unchanged.length,
		};
	}

	// ──────────────────────────────────────────────
	// 执行 Push
	// ──────────────────────────────────────────────

	private async executePush(
		client: GitHubClient,
		localFiles: Map<string, ArrayBuffer>,
		currentCommitSha: string | null,
		currentTreeSha: string | null,
		toUpload: FileDiff[],
		toDelete: FileDiff[]
	) {
		this.isSyncing = true;
		const startNotice = new Notice(
			`⬆️ 开始 Push，上传 ${toUpload.length}，删除 ${toDelete.length}...`,
			0
		);
		try {
			const message = this.buildCommitMessage();

			if (toUpload.length > 0) {
				const filesToUpload = toUpload
					.map((f) => {
						const content = localFiles.get(f.path);
						if (!content) return null;
						return { path: f.path, content };
					})
					.filter(Boolean) as { path: string; content: ArrayBuffer }[];

				const uploadResult = await client.batchUpload(
					filesToUpload,
					message,
					currentCommitSha,
					currentTreeSha
				);

				currentCommitSha = uploadResult.newCommitSha;
				currentTreeSha = uploadResult.newTreeSha;
			}

			if (toDelete.length > 0 && currentCommitSha && currentTreeSha) {
				await client.batchDelete(
					toDelete.map((f) => ({ path: f.path })),
					message,
					currentCommitSha,
					currentTreeSha
				);
			}

			startNotice.hide();
			new Notice(`✅ Push 完成：上传 ${toUpload.length}，删除 ${toDelete.length}`);
			await this.clearDirtyState(); // 新增：同步成功，重置状态
		} catch (err) {
			startNotice.hide();
			console.error("Push error:", err);
			new Notice(`❌ Push 出错: ${this.getErrorMessage(err)}`);
		} finally {
			this.isSyncing = false;
		}
	}

	// ──────────────────────────────────────────────
	// 执行 Pull
	// ──────────────────────────────────────────────
	private async executePull(
		client: GitHubClient,
		toDownload: FileDiff[],
		toRemove: FileDiff[]
	) {
		this.isSyncing = true;
		// 核心修复：加入冷却池，防止写入后延迟触发的 modify 事件被误判
		toDownload.forEach(f => this.recentlySyncedPaths.add(f.path));
		const startNotice = new Notice(
			`⬇️ 开始 Pull，下载 ${toDownload.length}，删除 ${toRemove.length}...`,
			0
		);
		try {
			// 下载 / 覆盖文件（并发下载，顺序写入）
			if (toDownload.length > 0) {
				const filesToDownload = toDownload.map((f) => ({ path: f.path, sha: f.remoteSha }));
				const downloaded = await client.downloadFiles(filesToDownload);

				for (const { path } of filesToDownload) {
					const content = downloaded.get(path);
					if (!content) continue;
					await this.writeLocalFile(path, content);
				}
			}

			// 删除本地多余文件
			for (const f of toRemove) {
				await this.deleteLocalFile(f.path);
			}

			startNotice.hide();
			new Notice(
				`✅ Pull 完成：下载 ${toDownload.length}，删除 ${toRemove.length}`
			);
			await this.clearDirtyState(); // 新增：同步成功，重置状态
		} catch (err) {
			startNotice.hide();
			console.error("Pull error:", err);
			new Notice(`❌ Pull 出错: ${this.getErrorMessage(err)}`);
		} finally {
			this.isSyncing = false;
			// 2秒后解除冷却
			setTimeout(() => {
				toDownload.forEach(f => this.recentlySyncedPaths.delete(f.path));
			}, 2000);
		}
	}

	// ──────────────────────────────────────────────
	// 执行智能同步
	// ──────────────────────────────────────────────

	private async executeSmartSync(
		client: GitHubClient,
		localFiles: Map<string, ArrayBuffer>,
		currentCommitSha: string | null,
		currentTreeSha: string | null,
		uploads: FileDiff[],
		downloads: FileDiff[]
	) {
		this.isSyncing = true;
		downloads.forEach(f => this.recentlySyncedPaths.add(f.path));

		const startNotice = new Notice(
			`🔀 开始智能同步，上传 ${uploads.length}，下载 ${downloads.length}...`,
			0
		);
		try {
			const message = this.buildCommitMessage();

			if (uploads.length > 0) {
				const filesToUpload = uploads
					.map((f) => {
						const content = localFiles.get(f.path);
						if (!content) return null;
						return { path: f.path, content };
					})
					.filter(Boolean) as { path: string; content: ArrayBuffer }[];

				if (filesToUpload.length > 0) {
					const uploadResult = await client.batchUpload(
						filesToUpload,
						message,
						currentCommitSha,
						currentTreeSha
					);
					currentCommitSha = uploadResult.newCommitSha;
					currentTreeSha = uploadResult.newTreeSha;
				}
			}

			if (downloads.length > 0) {
				const filesToDownload = downloads.map((f) => ({ path: f.path, sha: f.remoteSha }));
				const downloaded = await client.downloadFiles(filesToDownload);
				for (const { path } of filesToDownload) {
					const content = downloaded.get(path);
					if (!content) continue;
					await this.writeLocalFile(path, content);
				}
			}

			startNotice.hide();
			new Notice(
				`✅ 智能同步完成：上传 ${uploads.length}，下载 ${downloads.length}`
			);
			await this.clearDirtyState();
		} catch (err) {
			startNotice.hide();
			console.error("Smart sync error:", err);
			new Notice(`❌ 智能同步出错: ${this.getErrorMessage(err)}`);
		} finally {
			this.isSyncing = false;
			setTimeout(() => {
				downloads.forEach(f => this.recentlySyncedPaths.delete(f.path));
			}, 2000);
		}
	}

	// ──────────────────────────────────────────────
	// 本地文件操作
	// ──────────────────────────────────────────────

	private async readLocalFiles(ignore: string[]): Promise<LocalFileSnapshot> {
		const files = this.app.vault.getFiles();
		const filtered = files.filter((file) => !this.shouldIgnoreLocal(file.path, ignore));

		const items = await this.pMap(
			filtered,
			async (file) => {
				try {
					const content = await this.app.vault.readBinary(file);
					const mtime = file.stat?.mtime ?? file.stat?.ctime ?? 0;
					return { path: file.path, content, mtime };
				} catch (err) {
					console.warn(`读取本地文件失败: ${file.path}`, err);
					return null;
				}
			},
			8
		);

		const result: LocalFileSnapshot = {
			files: new Map<string, ArrayBuffer>(),
			mtimes: new Map<string, number>(),
		};

		for (const item of items) {
			if (!item) continue;
			result.files.set(item.path, item.content);
			result.mtimes.set(item.path, item.mtime);
		}

		return result;
	}

	private async writeLocalFile(
		path: string,
		content: ArrayBuffer
	): Promise<void> {
		const normalPath = normalizePath(path);
		// 确保父目录存在
		const dir = normalPath.substring(0, normalPath.lastIndexOf("/"));
		if (dir) {
			await this.ensureFolder(dir);
		}

		const existing = this.app.vault.getAbstractFileByPath(normalPath);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, content);
		} else {
			await this.app.vault.createBinary(normalPath, content);
		}
	}

	private async deleteLocalFile(path: string): Promise<void> {
		const normalPath = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalPath);
		if (file) {
			await this.app.vault.trash(file, true);
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current).catch(() => {});
			}
		}
	}

	private async pMap<T, R>(
		items: T[],
		fn: (item: T) => Promise<R>,
		concurrency: number
	): Promise<R[]> {
		if (items.length === 0) return [];
		const results: R[] = new Array(items.length);
		let index = 0;
		const workerCount = Math.min(concurrency, items.length);

		const worker = async () => {
			while (true) {
				const current = index++;
				if (current >= items.length) break;
				results[current] = await fn(items[current]);
			}
		};

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	// ──────────────────────────────────────────────
	// 辅助函数
	// ──────────────────────────────────────────────

	private checkConfig(): boolean {
		const { token, repository } = this.settings;
		if (!token || !repository) {
			new Notice(
				"⚠️ 请先在插件设置中填写 GitHub Token 和仓库名称"
			);
			// 打开设置
			(this.app as any).setting?.open?.();
			(this.app as any).setting?.openTabById?.("github-sync");
			return false;
		}
		return true;
	}

	private shouldIgnoreLocal(path: string, ignore: string[]): boolean {
		for (const prefix of ignore) {
			if (path === prefix || path.startsWith(prefix + "/")) return true;
		}
		return false;
	}

	private buildCommitMessage(): string {
		const now = new Date().toISOString().replace("T", " ").substring(0, 19);
		return this.settings.commitMessage.replace("{date}", now);
	}

	private getErrorMessage(err: unknown): string {
		if (err instanceof Error) return err.message;
		if (typeof err === "string") return err;
		return "未知错误";
	}

	// ──────────────────────────────────────────────
	// 样式注入
	// ──────────────────────────────────────────────

	private injectStyles() {
		if (document.getElementById("github-sync-styles")) return;
		const style = document.createElement("style");
		style.id = "github-sync-styles";
		style.textContent = CSS;
		document.head.appendChild(style);
	}
}

const CSS = `
/* ===== GitHub Sync Plugin Styles ===== */

.github-sync-modal {
  padding: 8px 4px;
}

.github-sync-modal h2 {
  margin-bottom: 8px;
}

.github-sync-subtitle {
  color: var(--text-muted);
  margin-bottom: 20px;
}

/* 全选按钮 */
.github-sync-select-all-btn {
margin-bottom: 8px;
font-size: 0.85em;
padding: 4px 10px;
cursor: pointer;
border-radius: 4px;
background: var(--background-secondary);
border: 1px solid var(--background-modifier-border);
color: var(--text-muted);
transition: all 0.15s ease;
}
.github-sync-select-all-btn:hover {
background: var(--background-modifier-hover);
color: var(--text-normal);
}

/* 模式选择按钮 */
.github-sync-mode-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 12px 0 8px;
}

.github-sync-mode-btn {
  flex: 1 1 180px;
  padding: 20px 16px;
  border: 2px solid var(--background-modifier-border);
  border-radius: 10px;
  background: var(--background-secondary);
  cursor: pointer;
  text-align: center;
  transition: all 0.15s ease;
}

.github-sync-mode-btn:hover {
  border-color: var(--interactive-accent);
  background: var(--background-modifier-hover);
  transform: translateY(-1px);
}

.github-sync-mode-icon {
  font-size: 2em;
  margin-bottom: 8px;
}

.github-sync-mode-label {
  font-size: 1.1em;
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: 4px;
}

.github-sync-mode-desc {
  font-size: 0.82em;
  color: var(--text-muted);
}

/* 摘要徽章 */
.github-sync-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}

.github-sync-badge {
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 0.85em;
  font-weight: 500;
}

.badge-added    { background: rgba(40, 167, 69, 0.15); color: #28a745; }
.badge-modified { background: rgba(255, 165, 0, 0.15); color: #e6922a; }
.badge-deleted  { background: rgba(220, 53, 69, 0.15); color: #dc3545; }
.badge-unchanged{ background: var(--background-modifier-border); color: var(--text-muted); }

/* 文件列表 */
.github-sync-file-list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  padding: 6px;
  margin: 8px 0;
  background: var(--background-primary-alt);
  font-family: var(--font-monospace);
  font-size: 0.82em;
}

.github-sync-file-row {
display: flex;
align-items: center;
gap: 6px;
padding: 4px 6px;
border-radius: 4px;
cursor: pointer;
user-select: none;
}

.github-sync-file-row:hover {
  background: var(--background-modifier-hover);
}
  
.github-sync-file-row input[type="checkbox"] {
margin: 0;
cursor: pointer;
flex-shrink: 0;
}

.file-icon { flex-shrink: 0; }

.file-path { 
  overflow: hidden; 
  text-overflow: ellipsis; 
  white-space: nowrap;
  color: var(--text-normal);
}

/* 核心颜色语义重构 */
.file-added    { color: #28a745; } /* 绿色：Push 新增 */
.file-download { color: #28a745; } /* 绿色：Smart/Pull 下载 */
.file-modified { color: #e6922a; } /* 橙色：内容修改 */
.file-upload   { color: #0366d6; } /* 蓝色：Smart 上传 */
.file-deleted  { color: #dc3545; text-decoration: line-through; } /* 红色：删除 */

.github-sync-more {
  color: var(--text-muted);
  font-size: 0.82em;
  text-align: center;
  margin: 4px 0 0;
}

/* 警告文字 */
.github-sync-warning {
  color: var(--text-muted);
  font-size: 0.85em;
  margin: 12px 0 4px;
}

.github-sync-no-changes {
  color: var(--text-success, #28a745);
  font-size: 1em;
  margin: 16px 0;
}

/* 进度条 */
.github-sync-progress-modal { text-align: center; padding: 24px 16px; }
.github-sync-progress-msg { color: var(--text-muted); margin: 8px 0 20px; min-height: 1.4em; }
.github-sync-progress-bar-wrap { width: 100%; height: 8px; background: var(--background-modifier-border); border-radius: 4px; overflow: hidden; }
.github-sync-progress-bar-fill { height: 100%; background: var(--interactive-accent); border-radius: 4px; width: 0%; transition: width 0.3s ease; }


.github-sync-progress-msg {
  color: var(--text-muted);
  margin: 8px 0 20px;
  min-height: 1.4em;
}

.github-sync-progress-bar-wrap {
  width: 100%;
  height: 8px;
  background: var(--background-modifier-border);
  border-radius: 4px;
  overflow: hidden;
}

.github-sync-progress-bar-fill {
  height: 100%;
  background: var(--interactive-accent);
  border-radius: 4px;
  width: 0%;
  transition: width 0.3s ease;
}

/* 设置页 */
.github-sync-settings .setting-item-description a {
  color: var(--link-color);
  text-decoration: underline;
}
`;
