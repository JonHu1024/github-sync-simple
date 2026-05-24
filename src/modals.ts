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
	onConfirm: () => Promise<void>;
}

export class ConfirmSyncModal extends Modal {
	private opts: ConfirmSyncOptions;

	constructor(app: App, opts: ConfirmSyncOptions) {
		super(app);
		this.opts = opts;
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
			const uploadCount = opts.toProcess.filter(
				(f) => f.direction === "upload"
			).length;
			const downloadCount = opts.toProcess.filter(
				(f) => f.direction === "download"
			).length;
			const deleteCount =
				opts.toRemove.length +
				opts.toProcess.filter((f) => f.direction === "delete").length;

			if (uploadCount > 0)
				summary.createEl("span", {
					text: `⬆️ ${uploadCount} 个上传`,
					cls: "github-sync-badge badge-added",
				});
			if (downloadCount > 0)
				summary.createEl("span", {
					text: `⬇️ ${downloadCount} 个下载`,
					cls: "github-sync-badge badge-modified",
				});
			if (deleteCount > 0)
				summary.createEl("span", {
					text: `🗑️ ${deleteCount} 个删除`,
					cls: "github-sync-badge badge-deleted",
				});
		} else {
			const added = opts.toProcess.filter((f) => f.changeType === "added").length;
			const modified = opts.toProcess.filter((f) => f.changeType === "modified").length;
			const deleted = opts.toRemove.length;

			if (added > 0)
				summary.createEl("span", {
					text: `➕ ${added} 个新增`,
					cls: "github-sync-badge badge-added",
				});
			if (modified > 0)
				summary.createEl("span", {
					text: `✏️ ${modified} 个修改`,
					cls: "github-sync-badge badge-modified",
				});
			if (deleted > 0)
				summary.createEl("span", {
					text: `🗑️ ${deleted} 个删除`,
					cls: "github-sync-badge badge-deleted",
				});
		}

		if (opts.unchanged > 0)
			summary.createEl("span", {
				text: `＝ ${opts.unchanged} 个未变化`,
				cls: "github-sync-badge badge-unchanged",
			});

		// 文件列表
		const listContainer = contentEl.createDiv("github-sync-file-list");

		const allFiles = [
			...opts.toProcess,
			...opts.toRemove,
		].sort((a, b) => a.path.localeCompare(b.path));

		// 最多显示 200 行，超出折叠
		const displayFiles = allFiles.slice(0, 200);
		const hasMore = allFiles.length > 200;

		for (const f of displayFiles) {
			const row = listContainer.createDiv("github-sync-file-row");
			let icon = "";
			let cls = "";
			if (isSmart) {
				if (f.direction === "upload") {
					icon = "⬆️";
					cls = f.changeType === "modified" ? "file-modified" : "file-added";
				} else if (f.direction === "download") {
					icon = "⬇️";
					cls = f.changeType === "modified" ? "file-modified" : "file-added";
				} else if (f.direction === "delete") {
					icon = "🗑️";
					cls = "file-deleted";
				}
			} else {
				if (f.changeType === "added") {
					icon = "➕";
					cls = "file-added";
				} else if (f.changeType === "modified") {
					icon = "✏️";
					cls = "file-modified";
				} else if (f.changeType === "deleted") {
					icon = "🗑️";
					cls = "file-deleted";
				}
			}
			row.createEl("span", { text: icon, cls: "file-icon" });
			row.createEl("span", { text: f.path, cls: `file-path ${cls}` });
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
				btn
					.setButtonText("取消")
					.onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText(`确认${modeLabel}`)
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("同步中...");
						await opts.onConfirm();
						this.close();
					})
			);
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
