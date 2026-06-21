"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GitHubSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/github.ts
var BLOB_CONCURRENCY = 10;
var DOWNLOAD_CONCURRENCY = 8;
var MTIME_CONCURRENCY = 6;
async function pMap(items, fn, concurrency) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
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
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32768;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
var GitHubClient = class {
  constructor(token, repository, branch) {
    this.token = token;
    const [owner, repo] = repository.split("/");
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || "main";
    this.baseUrl = `https://api.github.com/repos/${this.owner}/${this.repo}`;
  }
  async request(path, options = {}) {
    const url = path.startsWith("https://") ? path : `${this.baseUrl}${path}`;
    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...options.headers || {}
      }
    });
  }
  /** 验证 Token 和仓库是否可访问 */
  async validate() {
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
  async getBranchCommit() {
    const refResp = await this.request(`/git/refs/heads/${this.branch}`);
    if (!refResp.ok) return null;
    const ref = await refResp.json();
    const commitSha = ref.object.sha;
    const commitResp = await this.request(`/git/commits/${commitSha}`);
    if (!commitResp.ok) return null;
    const commit = await commitResp.json();
    return {
      commitSha,
      treeSha: commit.tree.sha,
      commitDate: commit.committer?.date ?? commit.author?.date ?? ""
    };
  }
  /** 获取完整文件树（递归，单次请求） */
  async getFullTree(treeSha) {
    const resp = await this.request(`/git/trees/${treeSha}?recursive=1`);
    if (!resp.ok) throw new Error(`\u83B7\u53D6\u6587\u4EF6\u6811\u5931\u8D25: HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.truncated) {
      console.warn("GitHub Sync: \u6587\u4EF6\u6811\u88AB\u622A\u65AD\uFF08\u8D85\u8FC7 100,000 \u4E2A\u6587\u4EF6\uFF09");
    }
    return data.tree;
  }
  /**
   * 获取仓库所有文件列表
   * 同时返回 commitSha / treeSha，供后续 batchUpload / batchDelete 复用，避免重复请求
   */
  async listAllFiles() {
    const info = await this.getBranchCommit();
    if (!info) {
      return { files: [], commitSha: null, treeSha: null, commitDate: "" };
    }
    const tree = await this.getFullTree(info.treeSha);
    const commitMs = info.commitDate ? new Date(info.commitDate).getTime() : 0;
    const files = tree.filter((item) => item.type === "blob").map((item) => ({
      path: item.path,
      sha: item.sha,
      size: item.size || 0,
      type: "blob",
      // 粗粒度：用分支最新 commit 时间兜底，精确时间在 getFileModTimes 中按需获取
      remoteMtime: commitMs
    }));
    return {
      files,
      commitSha: info.commitSha,
      treeSha: info.treeSha,
      commitDate: info.commitDate
    };
  }
  /**
   * 批量获取指定文件的精确最后修改时间（智能同步用）
   * 策略：并发查询每个文件的最近 1 条 commit（MTIME_CONCURRENCY 并发）
   * 返回 path -> mtime(ms)
   */
  async getFileModTimes(paths) {
    const result = /* @__PURE__ */ new Map();
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
            const dateStr = commits[0].commit?.committer?.date ?? commits[0].commit?.author?.date ?? "";
            if (dateStr) result.set(path, new Date(dateStr).getTime());
          }
        } catch {
        }
      },
      MTIME_CONCURRENCY
    );
    return result;
  }
  // ... 前面的代码保持不变 ...
  /** 下载单个文件（使用 API 以支持私有仓库及避免 raw 域名网络问题） */
  async downloadFile(path, sha) {
    if (sha) {
      const resp2 = await this.request(`/git/blobs/${sha}`, {
        headers: { Accept: "application/vnd.github.raw" }
      });
      if (resp2.ok) return resp2.arrayBuffer();
    }
    const resp = await this.request(`/contents/${encodePath(path)}`, {
      headers: { Accept: "application/vnd.github.raw" }
    });
    if (!resp.ok) throw new Error(`\u4E0B\u8F7D ${path} \u5931\u8D25: HTTP ${resp.status}`);
    return resp.arrayBuffer();
  }
  /** 并发批量下载，带进度回调；单文件失败会跳过，不中断整体同步 */
  async downloadFiles(files, onProgress) {
    const result = /* @__PURE__ */ new Map();
    let done = 0;
    await pMap(
      files,
      async (file) => {
        try {
          const buf = await this.downloadFile(file.path, file.sha);
          result.set(file.path, buf);
        } catch (err) {
          console.warn(`\u4E0B\u8F7D ${file.path} \u5931\u8D25:`, err);
        } finally {
          done++;
          onProgress?.(done, files.length, file.path);
        }
      },
      DOWNLOAD_CONCURRENCY
    );
    return result;
  }
  // ... 后面的代码保持不变 ...
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
  async batchUpload(files, message, currentCommitSha, currentTreeSha) {
    if (files.length === 0) {
      return {
        newCommitSha: currentCommitSha ?? "",
        newTreeSha: currentTreeSha ?? ""
      };
    }
    const isEmpty = !currentCommitSha || !currentTreeSha;
    if (isEmpty) {
      let lastCommitSha = "";
      let lastTreeSha = "";
      for (const file of files) {
        const resp = await this.request(`/contents/${encodePath(file.path)}`, {
          method: "PUT",
          body: JSON.stringify({
            message,
            content: arrayBufferToBase64(file.content),
            branch: this.branch
          })
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(
            `\u521D\u59CB\u5316\u4E0A\u4F20 ${file.path} \u5931\u8D25: ${err.message || `HTTP ${resp.status}`}`
          );
        }
        const data = await resp.json();
        lastCommitSha = data.commit?.sha ?? "";
        lastTreeSha = data.commit?.tree?.sha ?? "";
      }
      return { newCommitSha: lastCommitSha, newTreeSha: lastTreeSha };
    }
    const treeItems = await pMap(
      files,
      async (file) => {
        const sha = await this.createBlob(file.content);
        return { path: file.path, mode: "100644", type: "blob", sha };
      },
      BLOB_CONCURRENCY
    );
    const treeResp = await this.request(`/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: currentTreeSha, tree: treeItems })
    });
    if (!treeResp.ok) {
      throw new Error(
        `\u521B\u5EFA tree \u5931\u8D25: HTTP ${treeResp.status}: ${await treeResp.text().catch(() => "")}`
      );
    }
    const newTree = await treeResp.json();
    const commitResp = await this.request(`/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [currentCommitSha]
      })
    });
    if (!commitResp.ok) {
      throw new Error(
        `\u521B\u5EFA commit \u5931\u8D25: HTTP ${commitResp.status}: ${await commitResp.text().catch(() => "")}`
      );
    }
    const newCommit = await commitResp.json();
    const updateResp = await this.request(`/git/refs/heads/${this.branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha, force: true })
    });
    if (!updateResp.ok) {
      throw new Error(
        `\u66F4\u65B0\u5206\u652F\u5931\u8D25: HTTP ${updateResp.status}: ${await updateResp.text().catch(() => "")}`
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
  async batchDelete(files, message, currentCommitSha, currentTreeSha) {
    if (files.length === 0) {
      return { newCommitSha: currentCommitSha, newTreeSha: currentTreeSha };
    }
    const treeItems = files.map((f) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      sha: null
    }));
    const treeResp = await this.request(`/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: currentTreeSha, tree: treeItems })
    });
    if (!treeResp.ok) {
      throw new Error(
        `\u521B\u5EFA\u5220\u9664 tree \u5931\u8D25: HTTP ${treeResp.status}: ${await treeResp.text().catch(() => "")}`
      );
    }
    const newTree = await treeResp.json();
    const commitResp = await this.request(`/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [currentCommitSha]
      })
    });
    if (!commitResp.ok) {
      throw new Error(
        `\u521B\u5EFA\u5220\u9664 commit \u5931\u8D25: HTTP ${commitResp.status}: ${await commitResp.text().catch(() => "")}`
      );
    }
    const newCommit = await commitResp.json();
    const updateResp = await this.request(`/git/refs/heads/${this.branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha, force: true })
    });
    if (!updateResp.ok) {
      throw new Error(
        `\u66F4\u65B0\u5206\u652F\u5931\u8D25: HTTP ${updateResp.status}: ${await updateResp.text().catch(() => "")}`
      );
    }
    return { newCommitSha: newCommit.sha, newTreeSha: newTree.sha };
  }
  /** 兼容旧接口：单文件删除会直接走批量删除逻辑 */
  async deleteFile(path, message, currentCommitSha, currentTreeSha) {
    return this.batchDelete([{ path }], message, currentCommitSha, currentTreeSha);
  }
  async createBlob(content) {
    const resp = await this.request(`/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: arrayBufferToBase64(content),
        encoding: "base64"
      })
    });
    if (!resp.ok) {
      throw new Error(
        `\u521B\u5EFA blob \u5931\u8D25: HTTP ${resp.status}: ${await resp.text().catch(() => "")}`
      );
    }
    return (await resp.json()).sha;
  }
};
function encodePath(path) {
  return encodeURIComponent(path).replace(/%2F/g, "/");
}

// src/diff.ts
var HASH_CONCURRENCY = 8;
async function computeDiff(localFiles, remoteFiles, ignorePaths) {
  const result = {
    toUpload: [],
    toDelete: [],
    toDownload: [],
    toRemove: [],
    unchanged: []
  };
  const remoteMap = /* @__PURE__ */ new Map();
  for (const f of remoteFiles) {
    if (!shouldIgnore(f.path, ignorePaths)) {
      remoteMap.set(f.path, f);
    }
  }
  const localFiltered = [];
  for (const [path, buf] of localFiles) {
    if (!shouldIgnore(path, ignorePaths)) {
      localFiltered.push([path, buf]);
    }
  }
  for (const [path] of localFiltered) {
    if (!remoteMap.has(path)) {
      result.toUpload.push({ path, changeType: "added" });
      result.toRemove.push({ path, changeType: "deleted" });
    }
  }
  const commonFiles = localFiltered.filter(([path]) => remoteMap.has(path));
  const hashedFiles = await pMap(
    commonFiles,
    async ([path, buf]) => {
      const remote = remoteMap.get(path);
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
        remoteMtime: remote.remoteMtime
      });
      result.toDownload.push({
        path,
        changeType: "modified",
        remoteSha: remote.sha,
        remoteMtime: remote.remoteMtime
      });
    } else {
      result.unchanged.push({
        path,
        changeType: "unchanged",
        remoteSha: remote.sha,
        remoteMtime: remote.remoteMtime
      });
    }
    remoteMap.delete(path);
  }
  for (const [path, remote] of remoteMap) {
    result.toDelete.push({
      path,
      changeType: "deleted",
      remoteSha: remote.sha,
      remoteMtime: remote.remoteMtime
    });
    result.toDownload.push({
      path,
      changeType: "added",
      remoteSha: remote.sha,
      remoteMtime: remote.remoteMtime
    });
  }
  return result;
}
async function computeGitBlobSha(content) {
  const size = content.byteLength;
  const prefix = `blob ${size}\0`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const combined = new Uint8Array(prefixBytes.length + size);
  combined.set(prefixBytes, 0);
  combined.set(new Uint8Array(content), prefixBytes.length);
  const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
  return bufToHex(hashBuffer);
}
function bufToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function shouldIgnore(path, ignorePaths) {
  for (const prefix of ignorePaths) {
    if (path === prefix || path.startsWith(prefix + "/")) return true;
  }
  return false;
}

// src/modals.ts
var import_obsidian = require("obsidian");
var SyncModeModal = class extends import_obsidian.Modal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("github-sync-modal");
    contentEl.createEl("h2", { text: "GitHub \u540C\u6B65" });
    contentEl.createEl("p", {
      text: "\u8BF7\u9009\u62E9\u540C\u6B65\u65B9\u5411\uFF1A",
      cls: "github-sync-subtitle"
    });
    const btnContainer = contentEl.createDiv("github-sync-mode-buttons");
    const pushBtn = btnContainer.createEl("button", {
      cls: "github-sync-mode-btn"
    });
    pushBtn.createEl("div", { text: "\u2B06\uFE0F", cls: "github-sync-mode-icon" });
    pushBtn.createEl("div", { text: "Push", cls: "github-sync-mode-label" });
    pushBtn.createEl("div", {
      text: "\u5C06\u672C\u5730\u66F4\u6539\u4E0A\u4F20\u5230 GitHub",
      cls: "github-sync-mode-desc"
    });
    pushBtn.addEventListener("click", () => {
      this.close();
      this.onChoose("push");
    });
    const pullBtn = btnContainer.createEl("button", {
      cls: "github-sync-mode-btn"
    });
    pullBtn.createEl("div", { text: "\u2B07\uFE0F", cls: "github-sync-mode-icon" });
    pullBtn.createEl("div", { text: "Pull", cls: "github-sync-mode-label" });
    pullBtn.createEl("div", {
      text: "\u4ECE GitHub \u4E0B\u8F7D\u6700\u65B0\u5185\u5BB9\u5230\u672C\u5730",
      cls: "github-sync-mode-desc"
    });
    pullBtn.addEventListener("click", () => {
      this.close();
      this.onChoose("pull");
    });
    const smartBtn = btnContainer.createEl("button", {
      cls: "github-sync-mode-btn"
    });
    smartBtn.createEl("div", { text: "\u{1F500}", cls: "github-sync-mode-icon" });
    smartBtn.createEl("div", { text: "Smart", cls: "github-sync-mode-label" });
    smartBtn.createEl("div", {
      text: "\u6309\u672C\u5730 / GitHub \u6700\u65B0\u4FEE\u6539\u65F6\u95F4\u81EA\u52A8\u51B3\u5B9A\u4E0A\u4F20\u6216\u4E0B\u8F7D",
      cls: "github-sync-mode-desc"
    });
    smartBtn.addEventListener("click", () => {
      this.close();
      this.onChoose("smart");
    });
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ConfirmSyncModal = class extends import_obsidian.Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    this.selectedProcess = new Set(opts.toProcess.map((f) => f.path));
    this.selectedRemove = new Set(opts.toRemove.map((f) => f.path));
  }
  onOpen() {
    const { contentEl, opts } = this;
    contentEl.empty();
    contentEl.addClass("github-sync-modal");
    const isSmart = opts.mode === "smart";
    const modeLabel = opts.mode === "push" ? "Push \u2B06\uFE0F" : opts.mode === "pull" ? "Pull \u2B07\uFE0F" : "\u667A\u80FD\u540C\u6B65 \u{1F500}";
    contentEl.createEl("h2", { text: `\u786E\u8BA4${modeLabel}` });
    const total = opts.toProcess.length + opts.toRemove.length;
    if (total === 0) {
      contentEl.createEl("p", {
        text: `\u2705 \u5DF2\u662F\u6700\u65B0\uFF0C\u65E0\u9700\u540C\u6B65\uFF08${opts.unchanged} \u4E2A\u6587\u4EF6\u672A\u66F4\u6539\uFF09`,
        cls: "github-sync-no-changes"
      });
      new import_obsidian.Setting(contentEl).addButton(
        (btn) => btn.setButtonText("\u5173\u95ED").onClick(() => this.close())
      );
      return;
    }
    const summary = contentEl.createDiv("github-sync-summary");
    if (isSmart) {
      const uploadCount = opts.toProcess.filter((f) => f.direction === "upload").length;
      const downloadCount = opts.toProcess.filter((f) => f.direction === "download").length;
      const deleteCount = opts.toRemove.length + opts.toProcess.filter((f) => f.direction === "delete").length;
      if (uploadCount > 0) summary.createEl("span", { text: `\u2B06\uFE0F ${uploadCount} \u4E2A\u4E0A\u4F20`, cls: "github-sync-badge badge-upload" });
      if (downloadCount > 0) summary.createEl("span", { text: `\u2B07\uFE0F ${downloadCount} \u4E2A\u4E0B\u8F7D`, cls: "github-sync-badge badge-download" });
      if (deleteCount > 0) summary.createEl("span", { text: `\u{1F5D1}\uFE0F ${deleteCount} \u4E2A\u5220\u9664`, cls: "github-sync-badge badge-deleted" });
    } else {
      const added = opts.toProcess.filter((f) => f.changeType === "added").length;
      const modified = opts.toProcess.filter((f) => f.changeType === "modified").length;
      const deleted = opts.toRemove.length;
      if (added > 0) summary.createEl("span", { text: `\u2795 ${added} \u4E2A\u65B0\u589E`, cls: "github-sync-badge badge-added" });
      if (modified > 0) summary.createEl("span", { text: `\u270F\uFE0F ${modified} \u4E2A\u4FEE\u6539`, cls: "github-sync-badge badge-modified" });
      if (deleted > 0) summary.createEl("span", { text: `\u{1F5D1}\uFE0F ${deleted} \u4E2A\u5220\u9664`, cls: "github-sync-badge badge-deleted" });
    }
    if (opts.unchanged > 0)
      summary.createEl("span", {
        text: `\uFF1D ${opts.unchanged} \u4E2A\u672A\u53D8\u5316`,
        cls: "github-sync-badge badge-unchanged"
      });
    const selectAllBtn = contentEl.createEl("button", {
      text: "\u53D6\u6D88\u5168\u9009",
      cls: "github-sync-select-all-btn"
    });
    let isAllSelected = true;
    selectAllBtn.addEventListener("click", () => {
      isAllSelected = !isAllSelected;
      if (isAllSelected) {
        this.selectedProcess = new Set(this.opts.toProcess.map((f) => f.path));
        this.selectedRemove = new Set(this.opts.toRemove.map((f) => f.path));
        selectAllBtn.setText("\u53D6\u6D88\u5168\u9009");
      } else {
        this.selectedProcess.clear();
        this.selectedRemove.clear();
        selectAllBtn.setText("\u5168\u90E8\u9009\u4E2D");
      }
      this.updateCheckboxes();
    });
    const listContainer = contentEl.createDiv("github-sync-file-list");
    const allFiles = [
      ...opts.toProcess.map((f) => ({ ...f, _isRemove: false })),
      ...opts.toRemove.map((f) => ({ ...f, _isRemove: true }))
    ].sort((a, b) => a.path.localeCompare(b.path));
    const displayFiles = allFiles.slice(0, 200);
    const hasMore = allFiles.length > 200;
    for (const f of displayFiles) {
      const row = listContainer.createDiv("github-sync-file-row");
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = f._isRemove ? this.selectedRemove.has(f.path) : this.selectedProcess.has(f.path);
      checkbox.dataset.path = f.path;
      checkbox.dataset.isRemove = String(f._isRemove);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          f._isRemove ? this.selectedRemove.add(f.path) : this.selectedProcess.add(f.path);
        } else {
          f._isRemove ? this.selectedRemove.delete(f.path) : this.selectedProcess.delete(f.path);
        }
      });
      let icon = " ";
      let cls = " ";
      if (isSmart) {
        if (f.direction === "upload") {
          icon = "\u2B06\uFE0F";
          cls = "file-upload";
        } else if (f.direction === "download") {
          icon = "\u2B07\uFE0F";
          cls = "file-download";
        } else if (f.direction === "delete") {
          icon = "\u{1F5D1}\uFE0F";
          cls = "file-deleted";
        }
      } else if (opts.mode === "push") {
        if (f.changeType === "added") {
          icon = "\u2795";
          cls = "file-added";
        } else if (f.changeType === "modified") {
          icon = "\u270F\uFE0F";
          cls = "file-modified";
        } else if (f.changeType === "deleted") {
          icon = "\u{1F5D1}\uFE0F";
          cls = "file-deleted";
        }
      } else if (opts.mode === "pull") {
        if (f.changeType === "added") {
          icon = "\u2B07\uFE0F";
          cls = "file-download";
        } else if (f.changeType === "modified") {
          icon = "\u2B07\uFE0F\u270F\uFE0F";
          cls = "file-modified";
        } else if (f.changeType === "deleted") {
          icon = "\u{1F5D1}\uFE0F";
          cls = "file-deleted";
        }
      }
      row.createEl("span", { text: icon, cls: "file-icon" });
      row.createEl("span", { text: f.path, cls: `file-path ${cls}` });
      row.addEventListener("click", (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change"));
        }
      });
    }
    if (hasMore) {
      listContainer.createEl("p", {
        text: `...\u4EE5\u53CA ${allFiles.length - 200} \u4E2A\u5176\u4ED6\u6587\u4EF6`,
        cls: "github-sync-more"
      });
    }
    const actionWord = opts.mode === "push" ? "\u4E0A\u4F20\u5230 GitHub" : opts.mode === "pull" ? "\u8986\u76D6\u672C\u5730\u6587\u4EF6" : "\u6309\u6700\u65B0\u4FEE\u6539\u65F6\u95F4\u540C\u6B65";
    contentEl.createEl("p", {
      text: `\u786E\u8BA4\u540E\u5C06\u76F4\u63A5${actionWord}\uFF0C\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002`,
      cls: "github-sync-warning"
    });
    new import_obsidian.Setting(contentEl).addButton(
      (btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => this.close())
    ).addButton(
      (btn) => btn.setButtonText(`\u786E\u8BA4${modeLabel}`).setCta().onClick(async () => {
        const sp = this.opts.toProcess.filter((f) => this.selectedProcess.has(f.path));
        const sr = this.opts.toRemove.filter((f) => this.selectedRemove.has(f.path));
        if (sp.length === 0 && sr.length === 0) {
          new Notice("\u26A0\uFE0F \u672A\u9009\u62E9\u4EFB\u4F55\u6587\u4EF6");
          return;
        }
        btn.setDisabled(true);
        btn.setButtonText("\u540C\u6B65\u4E2D...");
        await opts.onConfirm(sp, sr);
        this.close();
      })
    );
  }
  updateCheckboxes() {
    const checkboxes = this.contentEl.querySelectorAll('input[type="checkbox"]');
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
};
var ProgressModal = class extends import_obsidian.Modal {
  constructor(app) {
    super(app);
    this.modalEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") e.stopPropagation();
    });
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("github-sync-modal", "github-sync-progress-modal");
    this.titleEl = contentEl.createEl("h2", { text: "\u540C\u6B65\u4E2D..." });
    this.messageEl = contentEl.createEl("p", {
      text: "\u6B63\u5728\u51C6\u5907...",
      cls: "github-sync-progress-msg"
    });
    this.progressEl = contentEl.createDiv("github-sync-progress-bar-wrap");
    this.progressBarEl = this.progressEl.createDiv(
      "github-sync-progress-bar-fill"
    );
  }
  setTitle(text) {
    if (this.titleEl) this.titleEl.setText(text);
  }
  setMessage(text) {
    if (this.messageEl) this.messageEl.setText(text);
  }
  setProgress(pct) {
    if (this.progressBarEl)
      this.progressBarEl.style.width = `${Math.min(100, pct)}%`;
  }
  onClose() {
    this.contentEl.empty();
  }
};
var UnsyncedWarningModal = class extends import_obsidian.Modal {
  constructor(app, paths, onSync) {
    super(app);
    this.paths = paths;
    this.onSync = onSync;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("github-sync-modal");
    contentEl.createEl("h2", { text: "\u26A0\uFE0F \u53D1\u73B0\u672A\u540C\u6B65\u7684\u4FEE\u6539" });
    contentEl.createEl("p", {
      text: "\u4E0A\u6B21\u9000\u51FA Obsidian \u65F6\u6CA1\u6709\u540C\u6B65\u3002\u518D\u6B21\u6267\u884C\u5305\u542B\u62C9\u53D6 (Pull/Smart) \u7684\u64CD\u4F5C\u8BF7\u5C0F\u5FC3\uFF0C\u4EE5\u514D\u8986\u76D6\u672C\u5730\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\u3002",
      cls: "github-sync-warning"
    });
    if (this.paths.length > 0) {
      contentEl.createEl("p", { text: "\u4EE5\u4E0B\u6587\u4EF6\u53EF\u80FD\u672A\u540C\u6B65\uFF1A" });
      const listContainer = contentEl.createDiv("github-sync-file-list");
      const displayPaths = this.paths.slice(0, 50);
      for (const p of displayPaths) {
        const row = listContainer.createDiv("github-sync-file-row");
        row.createEl("span", { text: "\u{1F4DD}", cls: "file-icon" });
        row.createEl("span", { text: p, cls: "file-path file-modified" });
      }
      if (this.paths.length > 50) {
        listContainer.createEl("p", {
          text: `...\u4EE5\u53CA ${this.paths.length - 50} \u4E2A\u5176\u4ED6\u6587\u4EF6`,
          cls: "github-sync-more"
        });
      }
    }
    new import_obsidian.Setting(contentEl).addButton(
      (btn) => btn.setButtonText("\u6211\u77E5\u9053\u4E86").onClick(() => this.close())
    ).addButton(
      (btn) => btn.setButtonText("\u7ACB\u5373\u67E5\u770B/\u540C\u6B65").setCta().onClick(() => {
        this.close();
        this.onSync();
      })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};

// src/settings.ts
var import_obsidian2 = require("obsidian");
var DEFAULT_SETTINGS = {
  token: "",
  repository: "",
  branch: "main",
  ignorePaths: ".obsidian/workspace.json",
  commitMessage: "obsidian sync {date}",
  showUnsyncedWarningOnStartup: true,
  hasUnsyncedChanges: false,
  lastUnsyncedPaths: []
};
var GitHubSyncSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("github-sync-settings");
    new import_obsidian2.Setting(containerEl).setName("GitHub Token").setDesc("\u4F60\u7684 GitHub Personal Access Token").addText((text) => text.setPlaceholder("ghp_xxxx").setValue(this.plugin.settings.token).onChange(async (value) => {
      this.plugin.settings.token = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("\u4ED3\u5E93").setDesc("\u683C\u5F0F: \u7528\u6237\u540D/\u4ED3\u5E93\u540D\uFF0C\u4F8B\u5982 myname/obsidian-notes").addText((text) => text.setPlaceholder("your-username/your-repo").setValue(this.plugin.settings.repository).onChange(async (value) => {
      this.plugin.settings.repository = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("\u5206\u652F").setDesc("\u9ED8\u8BA4 main").addText((text) => text.setPlaceholder("main").setValue(this.plugin.settings.branch).onChange(async (value) => {
      this.plugin.settings.branch = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("\u5FFD\u7565\u8DEF\u5F84").setDesc("\u6BCF\u884C\u4E00\u4E2A\u8DEF\u5F84\uFF0C\u4F8B\u5982 .obsidian/workspace.json").addTextArea((text) => text.setPlaceholder(".obsidian/workspace.json").setValue(this.plugin.settings.ignorePaths).onChange(async (value) => {
      this.plugin.settings.ignorePaths = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("\u63D0\u4EA4\u4FE1\u606F").setDesc("{date} \u4F1A\u88AB\u66FF\u6362\u4E3A\u5F53\u524D\u65F6\u95F4").addText((text) => text.setPlaceholder("obsidian sync {date}").setValue(this.plugin.settings.commitMessage).onChange(async (value) => {
      this.plugin.settings.commitMessage = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("\u542F\u52A8\u65F6\u63D0\u9192\u672A\u540C\u6B65\u72B6\u6001").setDesc("\u5982\u679C\u4E0A\u6B21\u9000\u51FA\u65F6\u6709\u672A\u540C\u6B65\u7684\u4FEE\u6539\uFF0C\u4E0B\u6B21\u6253\u5F00\u65F6\u5F39\u7A97\u63D0\u9192\u5E76\u5217\u51FA\u6587\u4EF6\uFF0C\u9632\u6B62\u62C9\u53D6\u65F6\u8986\u76D6\u3002").addToggle((toggle) => toggle.setValue(this.plugin.settings.showUnsyncedWarningOnStartup).onChange(async (value) => {
      this.plugin.settings.showUnsyncedWarningOnStartup = value;
      await this.plugin.saveSettings();
    }));
  }
};

// src/main.ts
var GitHubSyncPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    this.isSyncing = false;
    this.isDirty = false;
    // 状态栏元素
    // 新增：用于记录未同步文件和防抖保存
    this.unsyncedPaths = /* @__PURE__ */ new Set();
    this.saveStateTimer = null;
    this.recentlySyncedPaths = /* @__PURE__ */ new Set();
  }
  // 冷却池：防止同步写入触发的 modify 被误判
  async onload() {
    await this.loadSettings();
    if (this.settings.lastUnsyncedPaths && this.settings.lastUnsyncedPaths.length > 10) {
      this.settings.lastUnsyncedPaths = [];
      this.settings.hasUnsyncedChanges = false;
      await this.saveSettings();
    }
    if (this.settings.hasUnsyncedChanges) {
      this.isDirty = true;
      this.settings.lastUnsyncedPaths.forEach((p) => this.unsyncedPaths.add(p));
    }
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();
    this.addRibbonIcon("github", "GitHub Sync", () => {
      this.openSyncModal();
    });
    this.addCommand({
      id: "open-sync-modal",
      name: "\u6253\u5F00\u540C\u6B65\u5BF9\u8BDD\u6846",
      callback: () => this.openSyncModal()
    });
    this.addCommand({
      id: "quick-push",
      name: "Quick Push(\u76F4\u63A5\u663E\u793A\u5DEE\u5F02\u786E\u8BA4)",
      callback: () => this.startSync("push")
    });
    this.addCommand({
      id: "quick-pull",
      name: "Quick Pull(\u76F4\u63A5\u663E\u793A\u5DEE\u5F02\u786E\u8BA4)",
      callback: () => this.startSync("pull")
    });
    this.addCommand({
      id: "quick-smart",
      name: "\u5FEB\u901F\u667A\u80FD\u540C\u6B65(\u6309\u4FEE\u6539\u65F6\u95F4\u81EA\u52A8\u51B3\u5B9A\u65B9\u5411)",
      callback: () => this.startSync("smart")
    });
    this.addSettingTab(new GitHubSyncSettingTab(this.app, this));
    this.injectStyles();
    this.app.workspace.onLayoutReady(() => {
      let isBooting = true;
      setTimeout(() => {
        isBooting = false;
      }, 5e3);
      const markDirty = (file) => {
        if (isBooting) return;
        if (this.isSyncing) return;
        if (!(file instanceof import_obsidian3.TFile)) return;
        if (file.path.startsWith(".obsidian/") || file.path === ".obsidian") return;
        if (this.recentlySyncedPaths.has(file.path)) return;
        this.unsyncedPaths.add(file.path);
        this.setDirty(true);
        this.debounceSaveState();
      };
      this.registerEvent(this.app.vault.on("modify", markDirty));
      this.registerEvent(this.app.vault.on("create", markDirty));
      this.registerEvent(this.app.vault.on("delete", markDirty));
      this.registerEvent(this.app.vault.on("rename", (file) => {
        if (file instanceof import_obsidian3.TFile) markDirty(file);
      }));
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          if (file instanceof import_obsidian3.TFile) {
            menu.addSeparator();
            menu.addItem((item) => {
              item.setTitle("Push To GitHub").setIcon("arrow-up-circle").onClick(() => this.startSync("push", file.path));
            });
            menu.addItem((item) => {
              item.setTitle("Pull From GitHub").setIcon("arrow-down-circle").onClick(() => this.startSync("pull", file.path));
            });
            menu.addItem((item) => {
              item.setTitle("Smart Push/Pull").setIcon("refresh-cw").onClick(() => this.startSync("smart", file.path));
            });
          }
        })
      );
    });
    if (this.settings.showUnsyncedWarningOnStartup && this.settings.hasUnsyncedChanges) {
      setTimeout(() => {
        new UnsyncedWarningModal(
          this.app,
          this.settings.lastUnsyncedPaths || [],
          () => this.openSyncModal()
        ).open();
      }, 800);
    }
  }
  onunload() {
    const style = document.getElementById("github-sync-styles");
    if (style) style.remove();
  }
  // 新增：防抖保存状态到 data.json (5秒内无新修改才写入，避免卡顿)
  debounceSaveState() {
    if (this.saveStateTimer) window.clearTimeout(this.saveStateTimer);
    this.saveStateTimer = window.setTimeout(async () => {
      this.settings.hasUnsyncedChanges = this.isDirty;
      this.settings.lastUnsyncedPaths = Array.from(this.unsyncedPaths);
      await this.saveSettings();
    }, 5 * 1e3);
  }
  // 新增：彻底清理未同步状态（同步成功后调用）
  async clearDirtyState() {
    this.isDirty = false;
    this.unsyncedPaths.clear();
    this.settings.hasUnsyncedChanges = false;
    this.settings.lastUnsyncedPaths = [];
    if (this.saveStateTimer) window.clearTimeout(this.saveStateTimer);
    await this.saveSettings();
    this.updateStatusBar();
  }
  // 修改原有的 setDirty，使其与持久化状态同步
  setDirty(dirty) {
    if (this.isDirty !== dirty) {
      this.isDirty = dirty;
      this.updateStatusBar();
      if (!dirty) this.debounceSaveState();
    }
  }
  // 新增：更新状态栏 UI
  updateStatusBar() {
    if (this.isDirty) {
      this.statusBarEl.setText("\u26A0\uFE0FGitHub\u672A\u540C\u6B65");
      this.statusBarEl.style.color = "var(--text-warning, #e6922a)";
      this.statusBarEl.style.cursor = "pointer";
      this.statusBarEl.title = "\u70B9\u51FB\u7ACB\u5373\u540C\u6B65";
      this.statusBarEl.onclick = () => this.openSyncModal();
    } else {
      this.statusBarEl.setText("\u2705GitHub\u5DF2\u540C\u6B65");
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
  openSyncModal() {
    if (!this.checkConfig()) return;
    new SyncModeModal(this.app, (mode) => this.startSync(mode)).open();
  }
  async startSync(mode, targetPath) {
    if (!this.checkConfig()) return;
    if (this.isSyncing) {
      new import_obsidian3.Notice("\u6B63\u5728\u540C\u6B65...(\u70B9\u51FB\u5C4F\u5E55\u7A7A\u767D\u533A\u57DF\u53EF\u4EE5\u540E\u53F0\u8FD0\u884C\u540C\u6B65)");
      return;
    }
    const progress = new ProgressModal(this.app);
    progress.open();
    try {
      const { token, repository, branch, ignorePaths } = this.settings;
      const ignore = ignorePaths.split("\n").map((s) => s.trim()).filter(Boolean);
      const client = new GitHubClient(token, repository, branch);
      progress.setMessage(targetPath ? `\u8BFB\u53D6 ${targetPath}...` : "\u8BFB\u53D6\u672C\u5730 Vault \u6587\u4EF6...");
      const local = await this.readLocalFiles(ignore);
      progress.setMessage("\u83B7\u53D6 GitHub \u6587\u4EF6\u5217\u8868...");
      const remote = await client.listAllFiles();
      progress.setMessage("\u8BA1\u7B97\u5DEE\u5F02...");
      let diff = await computeDiff(local.files, remote.files, ignore);
      const hasChanges = diff.toUpload.length > 0 || diff.toDelete.length > 0 || diff.toDownload.length > 0 || diff.toRemove.length > 0;
      if (targetPath) {
        diff = {
          toUpload: diff.toUpload.filter((f) => f.path === targetPath),
          toDelete: diff.toDelete.filter((f) => f.path === targetPath),
          toDownload: diff.toDownload.filter((f) => f.path === targetPath),
          toRemove: diff.toRemove.filter((f) => f.path === targetPath),
          unchanged: diff.unchanged.filter((f) => f.path === targetPath)
        };
      }
      if (!hasChanges && !targetPath) {
        this.setDirty(false);
      }
      let smartPlan = null;
      if (mode === "smart") {
        progress.setMessage("\u5206\u6790\u4FEE\u6539\u65F6\u95F4\u5E76\u751F\u6210\u667A\u80FD\u540C\u6B65\u8BA1\u5212...");
        smartPlan = await this.buildSmartSyncPlan(client, local, remote.files, diff);
      }
      progress.close();
      if (mode === "push") {
        const toProcess = diff.toUpload;
        const toRemove = diff.toDelete;
        new ConfirmSyncModal(this.app, {
          mode: "push",
          toProcess,
          toRemove,
          unchanged: diff.unchanged.length,
          onConfirm: (selectedProcess, selectedRemove) => this.executePush(
            client,
            local.files,
            remote.commitSha,
            remote.treeSha,
            selectedProcess,
            selectedRemove
          )
        }).open();
      } else if (mode === "pull") {
        const toProcess = diff.toDownload;
        const toRemove = diff.toRemove;
        new ConfirmSyncModal(this.app, {
          mode: "pull",
          toProcess,
          toRemove,
          unchanged: diff.unchanged.length,
          onConfirm: (selectedProcess, selectedRemove) => this.executePull(client, selectedProcess, selectedRemove)
        }).open();
      } else {
        if (!smartPlan) throw new Error("\u667A\u80FD\u540C\u6B65\u8BA1\u5212\u751F\u6210\u5931\u8D25");
        new ConfirmSyncModal(this.app, {
          mode: "smart",
          toProcess: smartPlan.previewItems,
          toRemove: [],
          unchanged: smartPlan.unchanged,
          onConfirm: (selectedProcess, selectedRemove) => {
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
          }
        }).open();
      }
    } catch (err) {
      progress.close();
      console.error("GitHub Sync error:", err);
      new import_obsidian3.Notice(`\u274C \u540C\u6B65\u51FA\u9519: ${this.getErrorMessage(err)}`);
    } finally {
      this.isSyncing = false;
    }
  }
  // ──────────────────────────────────────────────
  // 智能同步计划
  // ──────────────────────────────────────────────
  async buildSmartSyncPlan(client, local, remoteFiles, diff) {
    const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));
    const uploads = [];
    const downloads = [];
    for (const item of diff.toUpload) {
      if (item.changeType === "added") {
        uploads.push({ ...item, direction: "upload" });
      }
    }
    for (const item of diff.toDownload) {
      if (item.changeType === "added") {
        downloads.push({
          ...item,
          direction: "download"
        });
      }
    }
    const modifiedPaths = diff.toUpload.filter((item) => item.changeType === "modified").map((item) => item.path);
    const remoteModTimes = modifiedPaths.length > 0 ? await client.getFileModTimes(modifiedPaths) : /* @__PURE__ */ new Map();
    for (const item of diff.toUpload) {
      if (item.changeType !== "modified") continue;
      const path = item.path;
      const localMtime = local.mtimes.get(path) ?? 0;
      const remoteMtime = remoteModTimes.get(path) ?? remoteMap.get(path)?.remoteMtime ?? 0;
      const target = localMtime >= remoteMtime ? "upload" : "download";
      const enrichedItem = {
        ...item,
        localMtime,
        remoteMtime,
        direction: target
      };
      if (target === "upload") uploads.push(enrichedItem);
      else downloads.push(enrichedItem);
    }
    const previewItems = [...uploads, ...downloads].sort(
      (a, b) => a.path.localeCompare(b.path)
    );
    return {
      uploads,
      downloads,
      previewItems,
      unchanged: diff.unchanged.length
    };
  }
  // ──────────────────────────────────────────────
  // 执行 Push
  // ──────────────────────────────────────────────
  async executePush(client, localFiles, currentCommitSha, currentTreeSha, toUpload, toDelete) {
    this.isSyncing = true;
    const startNotice = new import_obsidian3.Notice(
      `\u2B06\uFE0F \u5F00\u59CB Push\uFF0C\u4E0A\u4F20 ${toUpload.length}\uFF0C\u5220\u9664 ${toDelete.length}...`,
      0
    );
    try {
      const message = this.buildCommitMessage();
      if (toUpload.length > 0) {
        const filesToUpload = toUpload.map((f) => {
          const content = localFiles.get(f.path);
          if (!content) return null;
          return { path: f.path, content };
        }).filter(Boolean);
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
      new import_obsidian3.Notice(`\u2705 Push \u5B8C\u6210\uFF1A\u4E0A\u4F20 ${toUpload.length}\uFF0C\u5220\u9664 ${toDelete.length}`);
      await this.clearDirtyState();
    } catch (err) {
      startNotice.hide();
      console.error("Push error:", err);
      new import_obsidian3.Notice(`\u274C Push \u51FA\u9519: ${this.getErrorMessage(err)}`);
    } finally {
      this.isSyncing = false;
    }
  }
  // ──────────────────────────────────────────────
  // 执行 Pull
  // ──────────────────────────────────────────────
  async executePull(client, toDownload, toRemove) {
    this.isSyncing = true;
    toDownload.forEach((f) => this.recentlySyncedPaths.add(f.path));
    const startNotice = new import_obsidian3.Notice(
      `\u2B07\uFE0F \u5F00\u59CB Pull\uFF0C\u4E0B\u8F7D ${toDownload.length}\uFF0C\u5220\u9664 ${toRemove.length}...`,
      0
    );
    try {
      if (toDownload.length > 0) {
        const filesToDownload = toDownload.map((f) => ({ path: f.path, sha: f.remoteSha }));
        const downloaded = await client.downloadFiles(filesToDownload);
        for (const { path } of filesToDownload) {
          const content = downloaded.get(path);
          if (!content) continue;
          await this.writeLocalFile(path, content);
        }
      }
      for (const f of toRemove) {
        await this.deleteLocalFile(f.path);
      }
      startNotice.hide();
      new import_obsidian3.Notice(
        `\u2705 Pull \u5B8C\u6210\uFF1A\u4E0B\u8F7D ${toDownload.length}\uFF0C\u5220\u9664 ${toRemove.length}`
      );
      await this.clearDirtyState();
    } catch (err) {
      startNotice.hide();
      console.error("Pull error:", err);
      new import_obsidian3.Notice(`\u274C Pull \u51FA\u9519: ${this.getErrorMessage(err)}`);
    } finally {
      this.isSyncing = false;
      setTimeout(() => {
        toDownload.forEach((f) => this.recentlySyncedPaths.delete(f.path));
      }, 2e3);
    }
  }
  // ──────────────────────────────────────────────
  // 执行智能同步
  // ──────────────────────────────────────────────
  async executeSmartSync(client, localFiles, currentCommitSha, currentTreeSha, uploads, downloads) {
    this.isSyncing = true;
    downloads.forEach((f) => this.recentlySyncedPaths.add(f.path));
    const startNotice = new import_obsidian3.Notice(
      `\u{1F500} \u5F00\u59CB\u667A\u80FD\u540C\u6B65\uFF0C\u4E0A\u4F20 ${uploads.length}\uFF0C\u4E0B\u8F7D ${downloads.length}...`,
      0
    );
    try {
      const message = this.buildCommitMessage();
      if (uploads.length > 0) {
        const filesToUpload = uploads.map((f) => {
          const content = localFiles.get(f.path);
          if (!content) return null;
          return { path: f.path, content };
        }).filter(Boolean);
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
      new import_obsidian3.Notice(
        `\u2705 \u667A\u80FD\u540C\u6B65\u5B8C\u6210\uFF1A\u4E0A\u4F20 ${uploads.length}\uFF0C\u4E0B\u8F7D ${downloads.length}`
      );
      await this.clearDirtyState();
    } catch (err) {
      startNotice.hide();
      console.error("Smart sync error:", err);
      new import_obsidian3.Notice(`\u274C \u667A\u80FD\u540C\u6B65\u51FA\u9519: ${this.getErrorMessage(err)}`);
    } finally {
      this.isSyncing = false;
      setTimeout(() => {
        downloads.forEach((f) => this.recentlySyncedPaths.delete(f.path));
      }, 2e3);
    }
  }
  // ──────────────────────────────────────────────
  // 本地文件操作
  // ──────────────────────────────────────────────
  async readLocalFiles(ignore) {
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
          console.warn(`\u8BFB\u53D6\u672C\u5730\u6587\u4EF6\u5931\u8D25: ${file.path}`, err);
          return null;
        }
      },
      8
    );
    const result = {
      files: /* @__PURE__ */ new Map(),
      mtimes: /* @__PURE__ */ new Map()
    };
    for (const item of items) {
      if (!item) continue;
      result.files.set(item.path, item.content);
      result.mtimes.set(item.path, item.mtime);
    }
    return result;
  }
  async writeLocalFile(path, content) {
    const normalPath = (0, import_obsidian3.normalizePath)(path);
    const dir = normalPath.substring(0, normalPath.lastIndexOf("/"));
    if (dir) {
      await this.ensureFolder(dir);
    }
    const existing = this.app.vault.getAbstractFileByPath(normalPath);
    if (existing instanceof import_obsidian3.TFile) {
      await this.app.vault.modifyBinary(existing, content);
    } else {
      await this.app.vault.createBinary(normalPath, content);
    }
  }
  async deleteLocalFile(path) {
    const normalPath = (0, import_obsidian3.normalizePath)(path);
    const file = this.app.vault.getAbstractFileByPath(normalPath);
    if (file) {
      await this.app.vault.trash(file, true);
    }
  }
  async ensureFolder(path) {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current).catch(() => {
        });
      }
    }
  }
  async pMap(items, fn, concurrency) {
    if (items.length === 0) return [];
    const results = new Array(items.length);
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
  checkConfig() {
    const { token, repository } = this.settings;
    if (!token || !repository) {
      new import_obsidian3.Notice(
        "\u26A0\uFE0F \u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199 GitHub Token \u548C\u4ED3\u5E93\u540D\u79F0"
      );
      this.app.setting?.open?.();
      this.app.setting?.openTabById?.("github-sync");
      return false;
    }
    return true;
  }
  shouldIgnoreLocal(path, ignore) {
    for (const prefix of ignore) {
      if (path === prefix || path.startsWith(prefix + "/")) return true;
    }
    return false;
  }
  buildCommitMessage() {
    const now = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").substring(0, 19);
    return this.settings.commitMessage.replace("{date}", now);
  }
  getErrorMessage(err) {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return "\u672A\u77E5\u9519\u8BEF";
  }
  // ──────────────────────────────────────────────
  // 样式注入
  // ──────────────────────────────────────────────
  injectStyles() {
    if (document.getElementById("github-sync-styles")) return;
    const style = document.createElement("style");
    style.id = "github-sync-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
};
var CSS = `
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

/* \u5168\u9009\u6309\u94AE */
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

/* \u6A21\u5F0F\u9009\u62E9\u6309\u94AE */
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

/* \u6458\u8981\u5FBD\u7AE0 */
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

/* \u6587\u4EF6\u5217\u8868 */
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

/* \u6838\u5FC3\u989C\u8272\u8BED\u4E49\u91CD\u6784 */
.file-added    { color: #28a745; } /* \u7EFF\u8272\uFF1APush \u65B0\u589E */
.file-download { color: #28a745; } /* \u7EFF\u8272\uFF1ASmart/Pull \u4E0B\u8F7D */
.file-modified { color: #e6922a; } /* \u6A59\u8272\uFF1A\u5185\u5BB9\u4FEE\u6539 */
.file-upload   { color: #0366d6; } /* \u84DD\u8272\uFF1ASmart \u4E0A\u4F20 */
.file-deleted  { color: #dc3545; text-decoration: line-through; } /* \u7EA2\u8272\uFF1A\u5220\u9664 */

.github-sync-more {
  color: var(--text-muted);
  font-size: 0.82em;
  text-align: center;
  margin: 4px 0 0;
}

/* \u8B66\u544A\u6587\u5B57 */
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

/* \u8FDB\u5EA6\u6761 */
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

/* \u8BBE\u7F6E\u9875 */
.github-sync-settings .setting-item-description a {
  color: var(--link-color);
  text-decoration: underline;
}
`;
