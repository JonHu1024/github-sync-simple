// diff.ts — 计算本地与 GitHub 之间的差异（仅对比变化的文件）

import { pMap, GitHubFile } from "./github";

export type ChangeType = "added" | "modified" | "deleted" | "unchanged";
export type SyncDirection = "upload" | "download" | "delete";

export interface FileDiff {
	path: string;
	changeType: ChangeType;
	localMtime?: number;   // 本地文件修改时间
	remoteMtime?: number;  // GitHub 文件最后修改时间
	remoteSha?: string;    // GitHub 文件 SHA
	direction?: SyncDirection; // 智能同步时用于展示/执行方向
}

export interface DiffResult {
	toUpload: FileDiff[];   // Push 时：需要上传（新增 + 修改）
	toDelete: FileDiff[];   // Push 时：需要删除（本地不存在）
	toDownload: FileDiff[]; // Pull 时：需要下载（新增 + 修改）
	toRemove: FileDiff[];   // Pull 时：本地需要删除（远端不存在）
	unchanged: FileDiff[];
}

const HASH_CONCURRENCY = 8;

/**
 * 计算本地文件与 GitHub 文件树的差异
 * 使用 GitHub blob SHA（实为 git hash）与本地文件内容 hash 对比
 *
 * @param localFiles  本地文件列表: path -> ArrayBuffer
 * @param remoteFiles GitHub 文件列表
 * @param ignorePaths 忽略的路径前缀（如 .obsidian）
 */
export async function computeDiff(
	localFiles: Map<string, ArrayBuffer>,
	remoteFiles: GitHubFile[],
	ignorePaths: string[]
): Promise<DiffResult> {
	const result: DiffResult = {
		toUpload: [],
		toDelete: [],
		toDownload: [],
		toRemove: [],
		unchanged: [],
	};

	// 过滤远端文件
	const remoteMap = new Map<string, GitHubFile>();
	for (const f of remoteFiles) {
		if (!shouldIgnore(f.path, ignorePaths)) {
			remoteMap.set(f.path, f);
		}
	}

	// 过滤本地文件
	const localFiltered: Array<[string, ArrayBuffer]> = [];
	for (const [path, buf] of localFiles) {
		if (!shouldIgnore(path, ignorePaths)) {
			localFiltered.push([path, buf]);
		}
	}

	// 先处理仅本地存在的文件：不需要计算 hash
	for (const [path] of localFiltered) {
		if (!remoteMap.has(path)) {
			result.toUpload.push({ path, changeType: "added" });
			result.toRemove.push({ path, changeType: "deleted" });
		}
	}

	// 只对本地/远端都存在的文件计算 hash，避免无谓的开销
	const commonFiles = localFiltered.filter(([path]) => remoteMap.has(path));
	const hashedFiles = await pMap(
		commonFiles,
		async ([path, buf]) => {
			const remote = remoteMap.get(path)!;
			const localSha = await computeGitBlobSha(buf);
			return { path, remote, localSha };
		},
		HASH_CONCURRENCY
	);

	for (const item of hashedFiles) {
		const { path, remote, localSha } = item;
		if (localSha !== remote.sha) {
			result.toUpload.push({
				path,
				changeType: "modified",
				remoteSha: remote.sha,
				remoteMtime: remote.remoteMtime,
			});
			result.toDownload.push({
				path,
				changeType: "modified",
				remoteSha: remote.sha,
				remoteMtime: remote.remoteMtime,
			});
		} else {
			result.unchanged.push({
				path,
				changeType: "unchanged",
				remoteSha: remote.sha,
				remoteMtime: remote.remoteMtime,
			});
		}
		remoteMap.delete(path); // 标记为已处理
	}

	// 剩余远端文件（本地没有的）
	for (const [path, remote] of remoteMap) {
		// Push：本地删了 → 远端也删
		result.toDelete.push({
			path,
			changeType: "deleted",
			remoteSha: remote.sha,
			remoteMtime: remote.remoteMtime,
		});
		// Pull：远端有，本地没有 → 需要下载
		result.toDownload.push({
			path,
			changeType: "added",
			remoteSha: remote.sha,
			remoteMtime: remote.remoteMtime,
		});
	}

	return result;
}

/**
 * 计算 git blob SHA（与 GitHub 的 SHA 完全一致）
 * git blob SHA = SHA1("blob {size}\0{content}")
 */
export async function computeGitBlobSha(content: ArrayBuffer): Promise<string> {
	const size = content.byteLength;
	const prefix = `blob ${size}\0`;
	const prefixBytes = new TextEncoder().encode(prefix);

	const combined = new Uint8Array(prefixBytes.length + size);
	combined.set(prefixBytes, 0);
	combined.set(new Uint8Array(content), prefixBytes.length);

	const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
	return bufToHex(hashBuffer);
}

function bufToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function shouldIgnore(path: string, ignorePaths: string[]): boolean {
	for (const prefix of ignorePaths) {
		if (path === prefix || path.startsWith(prefix + "/")) return true;
	}
	return false;
}
