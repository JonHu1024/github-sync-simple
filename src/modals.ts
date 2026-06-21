// modals.ts — 同步确认对话框

import { App, Modal, Setting } from "obsidian";
import { FileDiff } from "./diff";

export type SyncMode = "push" | "pull" | "smart";

export class SyncModeModal extends Modal {
	private onChoose: (mode: SyncMode) => void;

	constructor(app: App, onChoose: (mode: SyncMode) => void) {
		super(app);
		this.onChoose = onChoose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal");

		contentEl.createEl("h2", { text: "GitHub 同步" });
		contentEl.createEl("p", {
			text: "请选择同步方向：",
			cls: "github-sync-subtitle",
		});

		const btnContainer = contentEl.createDiv("github-sync-mode-buttons");

		const pushBtn = btnContainer.createEl("button", {
			cls: "github-sync-mode-btn",
		});
		pushBtn.createEl("div", { text: "⬆️", cls: "github-sync-mode-icon" });
		pushBtn.createEl("div", { text: "Push", cls: "github-sync-mode-label" });
		pushBtn.createEl("div", {
			text: "将本地更改上传到 GitHub",
			cls: "github-sync-mode-desc",
		});
		pushBtn.addEventListener("click", () => {
			this.close();
			this.onChoose("push");
		});

		const pullBtn = btnContainer.createEl("button", {
			cls: "github-sync-mode-btn",
		});
		pullBtn.createEl("div", { text: "⬇️", cls: "github-sync-mode-icon" });
		pullBtn.createEl("div", { text: "Pull", cls: "github-sync-mode-label" });
		pullBtn.createEl("div", {
			text: "从 GitHub 下载最新内容到本地",
			cls: "github-sync-mode-desc",
		});
		pullBtn.addEventListener("click", () => {
			this.close();
			this.onChoose("pull");
		});

		const smartBtn = btnContainer.createEl("button", {
			cls: "github-sync-mode-btn",
		});
		smartBtn.createEl("div", { text: "🔀", cls: "github-sync-mode-icon" });
		smartBtn.createEl("div", { text: "Smart", cls: "github-sync-mode-label" });
		smartBtn.createEl("div", {
			text: "按本地 / GitHub 最新修改时间自动决定上传或下载",
			cls: "github-sync-mode-desc",
		});
		smartBtn.addEventListener("click", () => {
			this.close();
			this.onChoose("smart");
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

export interface ConfirmSyncOptions {
	mode: SyncMode;
	toProcess: FileDiff[];   // 新增/修改（smart 模式下可同时包含上传/下载项）
	toRemove: FileDiff[];    // 删除
	unchanged: number;
	// 修改：接收用户勾选后的文件列表
	onConfirm: (selectedProcess: FileDiff[], selectedRemove: FileDiff[]) => Promise<void>;
}

export class ConfirmSyncModal extends Modal {
	private opts: ConfirmSyncOptions;
	private selectedProcess: Set<string>;
	private selectedRemove: Set<string>;

	constructor(app: App, opts: ConfirmSyncOptions) {
		super(app);
		this.opts = opts;
		// 默认全部勾选
		this.selectedProcess = new Set(opts.toProcess.map((f) => f.path));
		this.selectedRemove = new Set(opts.toRemove.map((f) => f.path));
	}

	onOpen() {
		const { contentEl, opts } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal");

		const isSmart = opts.mode === "smart";
		const modeLabel =
			opts.mode === "push"
				? "Push ⬆️"
				: opts.mode === "pull"
				? "Pull ⬇️"
				: "智能同步 🔀";
		contentEl.createEl("h2", { text: `确认${modeLabel}` });

		const total = opts.toProcess.length + opts.toRemove.length;
		if (total === 0) {
			contentEl.createEl("p", {
				text: `✅ 已是最新，无需同步（${opts.unchanged} 个文件未更改）`,
				cls: "github-sync-no-changes",
			});
			new Setting(contentEl).addButton((btn) =>
				btn.setButtonText("关闭").onClick(() => this.close())
			);
			return;
		}

		// 统计摘要
		const summary = contentEl.createDiv("github-sync-summary");
		if (isSmart) {
			const uploadCount = opts.toProcess.filter((f) => f.direction === "upload").length;
			const downloadCount = opts.toProcess.filter((f) => f.direction === "download").length;
			const deleteCount = opts.toRemove.length + opts.toProcess.filter((f) => f.direction === "delete").length;

			if (uploadCount > 0) summary.createEl("span", { text: `⬆️ ${uploadCount} 个上传`, cls: "github-sync-badge badge-upload" });
			if (downloadCount > 0) summary.createEl("span", { text: `⬇️ ${downloadCount} 个下载`, cls: "github-sync-badge badge-download" });
			if (deleteCount > 0) summary.createEl("span", { text: `🗑️ ${deleteCount} 个删除`, cls: "github-sync-badge badge-deleted" });
		} else {
			const added = opts.toProcess.filter((f) => f.changeType === "added").length;
			const modified = opts.toProcess.filter((f) => f.changeType === "modified").length;
			const deleted = opts.toRemove.length;

			if (added > 0) summary.createEl("span", { text: `➕ ${added} 个新增`, cls: "github-sync-badge badge-added" });
			if (modified > 0) summary.createEl("span", { text: `✏️ ${modified} 个修改`, cls: "github-sync-badge badge-modified" });
			if (deleted > 0) summary.createEl("span", { text: `🗑️ ${deleted} 个删除`, cls: "github-sync-badge badge-deleted" });
		}

		if (opts.unchanged > 0)
			summary.createEl("span", {
				text: `＝ ${opts.unchanged} 个未变化`,
				cls: "github-sync-badge badge-unchanged",
			});

		// 新增：全选/取消全选 按钮
		const selectAllBtn = contentEl.createEl("button", {
			text: "取消全选",
			cls: "github-sync-select-all-btn",
		});
		let isAllSelected = true;
		selectAllBtn.addEventListener("click", () => {
			isAllSelected = !isAllSelected;
			if (isAllSelected) {
				this.selectedProcess = new Set(this.opts.toProcess.map((f) => f.path));
				this.selectedRemove = new Set(this.opts.toRemove.map((f) => f.path));
				selectAllBtn.setText("取消全选");
			} else {
				this.selectedProcess.clear();
				this.selectedRemove.clear();
				selectAllBtn.setText("全部选中");
			}
			this.updateCheckboxes();
		});

		// 文件列表
		const listContainer = contentEl.createDiv("github-sync-file-list");

		// 打上标记，区分是 Process 还是 Remove
		const allFiles = [
			...opts.toProcess.map((f) => ({ ...f, _isRemove: false })),
			...opts.toRemove.map((f) => ({ ...f, _isRemove: true })),
		].sort((a, b) => a.path.localeCompare(b.path));

		// 最多显示 200 行，超出折叠
		const displayFiles = allFiles.slice(0, 200);
		const hasMore = allFiles.length > 200;

		for (const f of displayFiles) {
			const row = listContainer.createDiv("github-sync-file-row");
			
			// 新增：复选框
			const checkbox = row.createEl("input", { type: "checkbox" });
			checkbox.checked = f._isRemove
				? this.selectedRemove.has(f.path)
				: this.selectedProcess.has(f.path);
			checkbox.dataset.path = f.path;
			checkbox.dataset.isRemove = String(f._isRemove);
			
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					f._isRemove ? this.selectedRemove.add(f.path) : this.selectedProcess.add(f.path);
				} else {
					f._isRemove ? this.selectedRemove.delete(f.path) : this.selectedProcess.delete(f.path);
				}
			});

			// 核心重构：根据模式和方向决定图标与颜色
			let icon = " ";
			let cls = " ";
			if (isSmart) {
				if (f.direction === "upload") {
					icon = "⬆️";
					cls = "file-upload";   // 蓝色：上传
				} else if (f.direction === "download") {
					icon = "⬇️";
					cls = "file-download"; // 绿色：下载
				} else if (f.direction === "delete") {
					icon = "🗑️";
					cls = "file-deleted";  // 红色：删除
				}
			} else if (opts.mode === "push") {
				if (f.changeType === "added") {
					icon = "➕";
					cls = "file-added";    // 绿色：新增
				} else if (f.changeType === "modified") {
					icon = "✏️";
					cls = "file-modified"; // 橙色：修改
				} else if (f.changeType === "deleted") {
					icon = "🗑️";
					cls = "file-deleted";  // 红色：删除
				}
			} else if (opts.mode === "pull") {
				if (f.changeType === "added") {
					icon = "⬇️";
					cls = "file-download"; // 绿色：下载新文件
				} else if (f.changeType === "modified") {
					icon = "⬇️✏️";
					cls = "file-modified"; // 橙色：下载修改
				} else if (f.changeType === "deleted") {
					icon = "🗑️";
					cls = "file-deleted";  // 红色：本地删除
				}
			}

			row.createEl("span", { text: icon, cls: "file-icon" });
			row.createEl("span", { text: f.path, cls: `file-path ${cls}` });

			// 点击整行也可以切换选中状态
			row.addEventListener("click", (e) => {
				if (e.target !== checkbox) {
					checkbox.checked = !checkbox.checked;
					checkbox.dispatchEvent(new Event("change"));
				}
			});
		}

		if (hasMore) {
			listContainer.createEl("p", {
				text: `...以及 ${allFiles.length - 200} 个其他文件`,
				cls: "github-sync-more",
			});
		}

		const actionWord =
			opts.mode === "push"
				? "上传到 GitHub"
				: opts.mode === "pull"
				? "覆盖本地文件"
				: "按最新修改时间同步";
		contentEl.createEl("p", {
			text: `确认后将直接${actionWord}，操作不可撤销。`,
			cls: "github-sync-warning",
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("取消").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText(`确认${modeLabel}`)
					.setCta()
					.onClick(async () => {
						// 过滤出选中的文件
						const sp = this.opts.toProcess.filter((f) => this.selectedProcess.has(f.path));
						const sr = this.opts.toRemove.filter((f) => this.selectedRemove.has(f.path));

						if (sp.length === 0 && sr.length === 0) {
							new Notice("⚠️ 未选择任何文件");
							return;
						}

						btn.setDisabled(true);
						btn.setButtonText("同步中...");
						await opts.onConfirm(sp, sr);
						this.close();
					})
			);
	}

	private updateCheckboxes() {
		const checkboxes = this.contentEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		checkboxes.forEach((cb) => {
			const path = cb.dataset.path;
			const isRemove = cb.dataset.isRemove === "true";
			if (path) {
				cb.checked = isRemove ? this.selectedRemove.has(path) : this.selectedProcess.has(path);
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class ProgressModal extends Modal {
	private titleEl!: HTMLElement;
	private messageEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private progressBarEl!: HTMLElement;

	constructor(app: App) {
		super(app);
		// 防止用户手动关闭
		this.modalEl.addEventListener("keydown", (e) => {
			if (e.key === "Escape") e.stopPropagation();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal", "github-sync-progress-modal");

		this.titleEl = contentEl.createEl("h2", { text: "同步中..." });
		this.messageEl = contentEl.createEl("p", {
			text: "正在准备...",
			cls: "github-sync-progress-msg",
		});
		this.progressEl = contentEl.createDiv("github-sync-progress-bar-wrap");
		this.progressBarEl = this.progressEl.createDiv(
			"github-sync-progress-bar-fill"
		);
	}

	setTitle(text: string) {
		if (this.titleEl) this.titleEl.setText(text);
	}

	setMessage(text: string) {
		if (this.messageEl) this.messageEl.setText(text);
	}

	setProgress(pct: number) {
		if (this.progressBarEl)
			this.progressBarEl.style.width = `${Math.min(100, pct)}%`;
	}

	onClose() {
		this.contentEl.empty();
	}
}

// 新增：未同步警告弹窗
export class UnsyncedWarningModal extends Modal {
	private paths: string[];
	private onSync: () => void;

	constructor(app: App, paths: string[], onSync: () => void) {
		super(app);
		this.paths = paths;
		this.onSync = onSync;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal");

		contentEl.createEl("h2", { text: "⚠️ 发现未同步的修改" });
		contentEl.createEl("p", {
			text: "上次退出 Obsidian 时没有同步。再次执行包含拉取 (Pull/Smart) 的操作请小心，以免覆盖本地未保存的修改。",
			cls: "github-sync-warning",
		});

		if (this.paths.length > 0) {
			contentEl.createEl("p", { text: "以下文件可能未同步：" });
			const listContainer = contentEl.createDiv("github-sync-file-list");
			// 最多显示 50 个
			const displayPaths = this.paths.slice(0, 50);
			for (const p of displayPaths) {
				const row = listContainer.createDiv("github-sync-file-row");
				row.createEl("span", { text: "📝", cls: "file-icon" });
				row.createEl("span", { text: p, cls: "file-path file-modified" });
			}
			if (this.paths.length > 50) {
				listContainer.createEl("p", {
					text: `...以及 ${this.paths.length - 50} 个其他文件`,
					cls: "github-sync-more",
				});
			}
		}

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("我知道了").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("立即查看/同步")
					.setCta()
					.onClick(() => {
						this.close();
						this.onSync();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}