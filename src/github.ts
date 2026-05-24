// github.ts — GitHub REST API (no local git required)

export interface GitHubFile {
	path: string;
	sha: string;
	size: number;
	type: "blob" | "tree";
	/** 远端文件的最后提交时间（Unix ms），仅智能同步时填充 */
	remoteMtime?: number;
}

export interface TreeItem {
	path: string;
	mode: string;
	type: string;
	sha: string;
	size?: number;
}

// ─── 并发控制 ──────────────────────────────────────────────────────────────
// GitHub API 对同一 token 的并发有软性限制，实测 8~10 并发最稳定
const BLOB_CONCURRENCY = 10;   // 创建 blob 并发数
const DOWNLOAD_CONCURRENCY = 8; // 下载文件并发数
const MTIME_CONCURRENCY = 6;    // 查询文件修改时间并发（此接口限速更严）

export async function pMap<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	concurrency: number
): Promise<R[]> {
	if (items.length === 0) return [];
	const results: R[] = new Array(items.length);
	let idx = 0;
	async function worker() {
		while (idx < items.length) {
			const i = idx++;
			results[i] = await fn(items[i]);
		}
	}
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		worker
	);
	await Promise.all(workers);
	return results;
}

// ─── base64（O(n) 分块版，避免字符串拼接 O(n²) 及 call stack overflow）────
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000; // 32 KB
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

// ──────────────────────────────────────────────────────────────────────────

export class GitHubClient {
	private token: string;
	private owner: string;
	private repo: string;
	private branch: string;
	private baseUrl: string;

	constructor(token: string, repository: string, branch: string) {
		this.token = token;
		const [owner, repo] = repository.split("/");
		this.owner = owner;
		this.repo = repo;
		this.branch = branch || "main";
		this.baseUrl = `https://api.github.com/repos/${this.owner}/${this.repo}`;
	}

	private async request(
		path: string,
		options: RequestInit = {}
	): Promise<Response> {
		const url = path.startsWith("https://") ? path : `${this.baseUrl}${path}`;
		return fetch(url, {
			...options,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
				...(options.headers || {}),
			},
		});
	}

	/** 验证 Token 和仓库是否可访问 */
	async validate(): Promise<{ ok: boolean; message: string }> {
		const resp = await this.request("");
		if (resp.ok) return { ok: true, message: "OK" };
		const json = await resp.json().catch(() => ({}));
		return { ok: false, message: json.message || `HTTP ${resp.status}` };
	}

	/**
	 * 一次请求链获取分支 HEAD 信息：commitSha + treeSha + commitDate
	 * 对比旧版：getBranchSha() + 单独 /git/commits/{sha} = 2 次串行请求
	 * 新版合并为 refs → commits，仍是 2 次但信息更完整，避免后续重复调用
	 */
	async getBranchCommit(): Promise<{
		commitSha: string;
		treeSha: string;
		commitDate: string;
	} | null> {
		const refResp = await this.request(`/git/refs/heads/${this.branch}`);
		if (!refResp.ok) return null;
		const ref = await refResp.json();
		const commitSha: string = ref.object.sha;

		const commitResp = await this.request(`/git/commits/${commitSha}`);
		if (!commitResp.ok) return null;
		const commit = await commitResp.json();
		return {
			commitSha,
			treeSha: commit.tree.sha,
			commitDate: commit.committer?.date ?? commit.author?.date ?? "",
		};
	}

	/** 获取完整文件树（递归，单次请求） */
	async getFullTree(treeSha: string): Promise<TreeItem[]> {
		const resp = await this.request(`/git/trees/${treeSha}?recursive=1`);
		if (!resp.ok) throw new Error(`获取文件树失败: HTTP ${resp.status}`);
		const data = await resp.json();
		if (data.truncated) {
			console.warn("GitHub Sync: 文件树被截断（超过 100,000 个文件）");
		}
		return data.tree as TreeItem[];
	}

	/**
	 * 获取仓库所有文件列表
	 * 同时返回 commitSha / treeSha，供后续 batchUpload / batchDelete 复用，避免重复请求
	 */
	async listAllFiles(): Promise<{
		files: GitHubFile[];
		commitSha: string | null;
		treeSha: string | null;
		commitDate: string;
	}> {
		const info = await this.getBranchCommit();
		if (!info) {
			return { files: [], commitSha: null, treeSha: null, commitDate: "" };
		}

		const tree = await this.getFullTree(info.treeSha);
		const commitMs = info.commitDate ? new Date(info.commitDate).getTime() : 0;

		const files: GitHubFile[] = tree
			.filter((item) => item.type === "blob")
			.map((item) => ({
				path: item.path,
				sha: item.sha,
				size: item.size || 0,
				type: "blob",
				// 粗粒度：用分支最新 commit 时间兜底，精确时间在 getFileModTimes 中按需获取
				remoteMtime: commitMs,
			}));

		return {
			files,
			commitSha: info.commitSha,
			treeSha: info.treeSha,
			commitDate: info.commitDate,
		};
	}

	/**
	 * 批量获取指定文件的精确最后修改时间（智能同步用）
	 * 策略：并发查询每个文件的最近 1 条 commit（MTIME_CONCURRENCY 并发）
	 * 返回 path -> mtime(ms)
	 */
	async getFileModTimes(paths: string[]): Promise<Map<string, number>> {
		const result = new Map<string, number>();
		await pMap(
			paths,
			async (path) => {
				try {
					const resp = await this.request(
						`/commits?path=${encodeURIComponent(path)}&per_page=1&sha=${this.branch}`
					);
					if (!resp.ok) return;
					const commits = await resp.json();
					if (commits.length > 0) {
						const dateStr: string =
							commits[0].commit?.committer?.date ??
							commits[0].commit?.author?.date ??
							"";
						if (dateStr) result.set(path, new Date(dateStr).getTime());
					}
				} catch {
					// 忽略单个文件错误，不中断整体流程
				}
			},
			MTIME_CONCURRENCY
		);
		return result;
	}

	/** 下载单个文件（raw CDN，比 contents API 快） */
	async downloadFile(path: string): Promise<ArrayBuffer> {
		const rawUrl = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${encodePath(path)}`;
		const resp = await fetch(rawUrl, {
			headers: { Authorization: `Bearer ${this.token}` },
		});
		if (!resp.ok) throw new Error(`下载 ${path} 失败: HTTP ${resp.status}`);
		return resp.arrayBuffer();
	}

	/** 并发批量下载，带进度回调；单文件失败会跳过，不中断整体同步 */
	async downloadFiles(
		paths: string[],
		onProgress?: (done: number, total: number, currentPath: string) => void
	): Promise<Map<string, ArrayBuffer>> {
		const result = new Map<string, ArrayBuffer>();
		let done = 0;
		await pMap(
			paths,
			async (path) => {
				try {
					const buf = await this.downloadFile(path);
					result.set(path, buf);
				} catch (err) {
					console.warn(`下载 ${path} 失败:`, err);
				} finally {
					done++;
					onProgress?.(done, paths.length, path);
				}
			},
			DOWNLOAD_CONCURRENCY
		);
		return result;
	}

	/**
	 * 批量上传（增量 Git Trees API）
	 *
	 * 关键改进（vs 旧版）：
	 * ① 使用 base_tree 增量模式：只在 tree 中描述"变化的文件"，
	 *    GitHub 自动继承其余文件，tree payload 极小，速度极快
	 * ② blob 创建受控并发（BLOB_CONCURRENCY），不触发限流
	 * ③ 复用外部已有的 commitSha/treeSha，无需再次 getBranchSha()
	 *
	 * @param files            仅传需要新增/修改的文件（不含未变化文件）
	 * @param message          commit 信息
	 * @param currentCommitSha 当前 HEAD commit SHA（null 表示空仓库）
	 * @param currentTreeSha   当前 tree SHA（null 表示空仓库）
	 */
	async batchUpload(
		files: { path: string; content: ArrayBuffer }[],
		message: string,
		currentCommitSha: string | null,
		currentTreeSha: string | null
	): Promise<{ newCommitSha: string; newTreeSha: string }> {
		if (files.length === 0) {
			return {
				newCommitSha: currentCommitSha ?? "",
				newTreeSha: currentTreeSha ?? "",
			};
		}

		const isEmpty = !currentCommitSha || !currentTreeSha;

		// ── 空仓库：content API 串行初始化（GitHub 必须先有 ref 才能用 Trees API）
		if (isEmpty) {
			let lastCommitSha = "";
			let lastTreeSha = "";
			for (const file of files) {
				const resp = await this.request(`/contents/${encodePath(file.path)}`, {
					method: "PUT",
					body: JSON.stringify({
						message,
						content: arrayBufferToBase64(file.content),
						branch: this.branch,
					}),
				});
				if (!resp.ok) {
					const err = await resp.json().catch(() => ({}));
					throw new Error(
						`初始化上传 ${file.path} 失败: ${err.message || `HTTP ${resp.status}`}`
					);
				}
				const data = await resp.json();
				lastCommitSha = data.commit?.sha ?? "";
				lastTreeSha = data.commit?.tree?.sha ?? "";
			}
			return { newCommitSha: lastCommitSha, newTreeSha: lastTreeSha };
		}

		// ── 非空仓库：增量 Git Trees API ──

		// Step 1: 并发创建 blob（受控并发）
		const treeItems = await pMap(
			files,
			async (file) => {
				const sha = await this.createBlob(file.content);
				return { path: file.path, mode: "100644", type: "blob", sha } as const;
			},
			BLOB_CONCURRENCY
		);

		// Step 2: 创建增量 tree（base_tree 会自动继承其余文件）
		const treeResp = await this.request(`/git/trees`, {
			method: "POST",
			body: JSON.stringify({ base_tree: currentTreeSha, tree: treeItems }),
		});
		if (!treeResp.ok) {
			throw new Error(
				`创建 tree 失败: HTTP ${treeResp.status}: ${await treeResp.text().catch(() => "")}`
			);
		}
		const newTree = await treeResp.json();

		// Step 3: 创建 commit
		const commitResp = await this.request(`/git/commits`, {
			method: "POST",
			body: JSON.stringify({
				message,
				tree: newTree.sha,
				parents: [currentCommitSha],
			}),
		});
		if (!commitResp.ok) {
			throw new Error(
				`创建 commit 失败: HTTP ${commitResp.status}: ${await commitResp.text().catch(() => "")}`
			);
		}
		const newCommit = await commitResp.json();

		// Step 4: 更新分支引用
		const updateResp = await this.request(`/git/refs/heads/${this.branch}`, {
			method: "PATCH",
			body: JSON.stringify({ sha: newCommit.sha, force: true }),
		});
		if (!updateResp.ok) {
			throw new Error(
				`更新分支失败: HTTP ${updateResp.status}: ${await updateResp.text().catch(() => "")}`
			);
		}

		return { newCommitSha: newCommit.sha, newTreeSha: newTree.sha };
	}

	/**
	 * 批量删除远端文件（利用 Git Trees API，sha=null 表示删除）
	 * 单次 commit 删除所有文件，比逐文件 DELETE /contents/... 快得多
	 *
	 * @param files            要删除的文件列表
	 * @param message          commit 信息
	 * @param currentCommitSha 当前 HEAD commit SHA
	 * @param currentTreeSha   当前 tree SHA
	 */
	async batchDelete(
		files: { path: string }[],
		message: string,
		currentCommitSha: string,
		currentTreeSha: string
	): Promise<{ newCommitSha: string; newTreeSha: string }> {
		if (files.length === 0) {
			return { newCommitSha: currentCommitSha, newTreeSha: currentTreeSha };
		}

		// sha: null 告诉 GitHub 删除此路径
		const treeItems = files.map((f) => ({
			path: f.path,
			mode: "100644",
			type: "blob",
			sha: null,
		}));

		const treeResp = await this.request(`/git/trees`, {
			method: "POST",
			body: JSON.stringify({ base_tree: currentTreeSha, tree: treeItems }),
		});
		if (!treeResp.ok) {
			throw new Error(
				`创建删除 tree 失败: HTTP ${treeResp.status}: ${await treeResp.text().catch(() => "")}`
			);
		}
		const newTree = await treeResp.json();

		const commitResp = await this.request(`/git/commits`, {
			method: "POST",
			body: JSON.stringify({
				message,
				tree: newTree.sha,
				parents: [currentCommitSha],
			}),
		});
		if (!commitResp.ok) {
			throw new Error(
				`创建删除 commit 失败: HTTP ${commitResp.status}: ${await commitResp.text().catch(() => "")}`
			);
		}
		const newCommit = await commitResp.json();

		const updateResp = await this.request(`/git/refs/heads/${this.branch}`, {
			method: "PATCH",
			body: JSON.stringify({ sha: newCommit.sha, force: true }),
		});
		if (!updateResp.ok) {
			throw new Error(
				`更新分支失败: HTTP ${updateResp.status}: ${await updateResp.text().catch(() => "")}`
			);
		}

		return { newCommitSha: newCommit.sha, newTreeSha: newTree.sha };
	}

	/** 兼容旧接口：单文件删除会直接走批量删除逻辑 */
	async deleteFile(
		path: string,
		message: string,
		currentCommitSha: string,
		currentTreeSha: string
	): Promise<{ newCommitSha: string; newTreeSha: string }> {
		return this.batchDelete([{ path }], message, currentCommitSha, currentTreeSha);
	}

	private async createBlob(content: ArrayBuffer): Promise<string> {
		const resp = await this.request(`/git/blobs`, {
			method: "POST",
			body: JSON.stringify({
				content: arrayBufferToBase64(content),
				encoding: "base64",
			}),
		});
		if (!resp.ok) {
			throw new Error(
				`创建 blob 失败: HTTP ${resp.status}: ${await resp.text().catch(() => "")}`
			);
		}
		return (await resp.json()).sha;
	}
}

function encodePath(path: string): string {
	return encodeURIComponent(path).replace(/%2F/g, "/");
}
