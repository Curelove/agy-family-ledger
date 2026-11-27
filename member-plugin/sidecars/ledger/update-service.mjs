/**
 * 内置 GitHub Releases 更新检查服务 (v1.4.0 · 零第三方依赖 · 跨平台)
 *
 * 隐私与安全边界：
 * 1. 仅向公开 GitHub 仓库（api.github.com 与 github.com/.../releases.atom）发起只读 GET 请求；
 * 2. 严格遵守家庭组插件隐私约定：不读取系统注册表、不扫描本机进程或代理软件配置，
 *    仅复用用户在「连接配置」中显式填写的 proxyUrl 或标准 HTTPS_PROXY / HTTP_PROXY 环境变量；
 * 3. GitHub API 触发 403/429 频率限制或超时时，自动降级至公开 releases.atom 源，免 Token 稳定检查；
 * 4. 6 小时本地缓存 + 并发去重 + 按版本忽略（更高版本发布时自动恢复提醒）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_REPO_URL = "https://github.com/Curelove/agy-family-ledger";
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_UPDATE_RESP_BYTES = 2 * 1024 * 1024;

export function getDefaultUpdateCachePath() {
  return path.join(os.homedir(), ".gemini", "antigravity", "sidecar_data", "agy-family-ledger", "update_cache.json");
}

export function parseGithubRepo(repoUrl) {
  const raw = String(repoUrl || "").trim();
  if (!raw) return null;
  const httpsMatch = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(raw);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/i, "") };
  }
  const sshMatch = /github\.com:([^/\s]+)\/([^/\s#?]+)/i.exec(raw);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/i, "") };
  }
  return null;
}

function parseSemverParts(v) {
  const clean = String(v || "").trim().replace(/^v/i, "");
  const [coreRaw, preRaw = ""] = clean.split("-", 2);
  const nums = coreRaw.split(".").map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  return {
    major: nums[0] || 0,
    minor: nums[1] || 0,
    patch: nums[2] || 0,
    pre: preRaw.trim(),
  };
}

export function compareSemver(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] > pb[key]) return 1;
    if (pa[key] < pb[key]) return -1;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

export function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

export function computeUpdateNotificationState(result, ignoredVersion = "") {
  const cleanIgnored = String(ignoredVersion || "").trim().replace(/^v/i, "");
  if (!result || !result.ok || !result.latestVersion) {
    return {
      ignoredVersion: cleanIgnored,
      isIgnored: false,
      shouldNotify: false,
    };
  }
  const updateAvailable = Boolean(result.updateAvailable);
  const isIgnored = Boolean(
    updateAvailable && cleanIgnored && compareSemver(result.latestVersion, cleanIgnored) <= 0
  );
  return {
    ignoredVersion: cleanIgnored,
    isIgnored,
    shouldNotify: Boolean(updateAvailable && !isIgnored),
  };
}

function normalizeProxyString(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname || !u.port) return "";
    return u.toString();
  } catch {
    return "";
  }
}

export function resolveConfiguredProxyUrl(explicitProxy = "") {
  const candidate =
    String(explicitProxy || "").trim() ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    "";
  return normalizeProxyString(candidate);
}

function requestViaHttpConnect(targetUrl, proxyUrl, { timeoutMs = 7000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy = new URL(proxyUrl);
    const port = Number(target.port) || 443;
    const hostPort = `${target.hostname}:${port}`;
    const proxyAuth =
      proxy.username || proxy.password
        ? "Basic " +
          Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")
        : "";

    let settled = false;
    let connectReq = null;
    let tlsSock = null;
    let httpsReq = null;

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { connectReq?.destroy?.(); } catch {}
      try { httpsReq?.destroy?.(); } catch {}
      try { tlsSock?.destroy?.(); } catch {}
      reject(err);
    };

    const timer = setTimeout(() => {
      finishErr(new Error(`请求超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: hostPort,
      headers: {
        Host: hostPort,
        ...(proxyAuth ? { "Proxy-Authorization": proxyAuth } : {}),
      },
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch {}
        finishErr(new Error(`代理 CONNECT 失败 (HTTP ${res.statusCode})`));
        return;
      }

      tlsSock = tls.connect({
        socket,
        servername: target.hostname,
      });

      tlsSock.once("error", finishErr);

      httpsReq = https.request(
        {
          hostname: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: {
            Host: target.hostname,
            "User-Agent": "agy-family-ledger-updater",
            Accept: "application/vnd.github+json",
            ...headers,
          },
          createConnection: () => tlsSock,
          agent: false,
        },
        (httpsRes) => {
          const chunks = [];
          let totalBytes = 0;
          httpsRes.on("error", finishErr);
          httpsRes.on("data", (c) => {
            totalBytes += c.length;
            if (totalBytes > MAX_UPDATE_RESP_BYTES) {
              finishErr(new Error("响应体超出大小限制"));
              return;
            }
            chunks.push(c);
          });
          httpsRes.on("end", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { tlsSock?.destroy?.(); } catch {}
            resolve({
              statusCode: httpsRes.statusCode || 0,
              headers: httpsRes.headers || {},
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        }
      );

      httpsReq.on("error", finishErr);
      httpsReq.end();
    });

    connectReq.on("error", finishErr);
    connectReq.end();
  });
}

function requestDirectHttps(targetUrl, { timeoutMs = 7000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    let settled = false;
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.destroy(); } catch {}
      reject(err);
    };
    const req = https.request(
      {
        hostname: target.hostname,
        port: Number(target.port) || 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          "User-Agent": "agy-family-ledger-updater",
          Accept: "application/vnd.github+json",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;
        res.on("error", finishErr);
        res.on("data", (c) => {
          totalBytes += c.length;
          if (totalBytes > MAX_UPDATE_RESP_BYTES) {
            finishErr(new Error("响应体超出大小限制"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    const timer = setTimeout(() => {
      finishErr(new Error(`请求超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    req.on("error", finishErr);
    req.end();
  });
}

export async function httpsGetText(url, { proxyUrl = "", timeoutMs = 7000, headers = {}, maxRedirects = 3 } = {}) {
  let curUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let resp;
    if (proxyUrl) {
      const proxyTimeout = Math.min(timeoutMs, 4500);
      const directTimeout = Math.min(timeoutMs, 3500);
      try {
        resp = await requestViaHttpConnect(curUrl, proxyUrl, { timeoutMs: proxyTimeout, headers });
      } catch (proxyErr) {
        try {
          resp = await requestDirectHttps(curUrl, { timeoutMs: directTimeout, headers });
        } catch {
          throw proxyErr;
        }
      }
    } else {
      resp = await requestDirectHttps(curUrl, { timeoutMs, headers });
    }

    if ([301, 302, 307, 308].includes(resp.statusCode) && resp.headers?.location) {
      curUrl = new URL(resp.headers.location, curUrl).toString();
      continue;
    }

    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      const err = new Error(`HTTP ${resp.statusCode}`);
      err.statusCode = resp.statusCode;
      err.responseBody = resp.body;
      throw err;
    }

    return resp.body || "";
  }
  throw new Error("重定向次数过多");
}

export async function httpsGetJson(url, opts = {}) {
  const text = await httpsGetText(url, opts);
  return JSON.parse(text || "null");
}

function parseSingleAtomEntry(entryXml, fallbackRepoUrl) {
  const linkMatch = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryXml);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(entryXml);
  const updatedMatch = /<updated\b[^>]*>([\s\S]*?)<\/updated>/i.exec(entryXml);
  const contentMatch = /<content\b[^>]*>([\s\S]*?)<\/content>/i.exec(entryXml);
  const idMatch = /<id\b[^>]*>([\s\S]*?)<\/id>/i.exec(entryXml);

  const rawHref = linkMatch?.[1] ? decodeHtmlEntities(linkMatch[1].trim()) : "";
  let releaseUrl = `${fallbackRepoUrl}/releases`;
  if (rawHref) {
    try {
      releaseUrl = new URL(rawHref, fallbackRepoUrl).toString();
    } catch {}
  }

  let tagName = "";
  const tagFromUrl = /\/releases\/tag\/([^/?#]+)/i.exec(releaseUrl);
  if (tagFromUrl?.[1]) {
    try {
      tagName = decodeURIComponent(tagFromUrl[1].trim());
    } catch {
      tagName = tagFromUrl[1].trim();
    }
  }
  if (!tagName && idMatch?.[1]) {
    const idSegs = idMatch[1].trim().split("/");
    tagName = idSegs[idSegs.length - 1] || "";
  }
  if (!tagName) return null;

  const title = decodeHtmlEntities(
    decodeHtmlEntities((titleMatch?.[1] || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
  ).trim();
  const updated = (updatedMatch?.[1] || "").trim();
  const rawHtml = decodeHtmlEntities((contentMatch?.[1] || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
  const plainBody = decodeHtmlEntities(
    rawHtml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\/(?:p|li|h[1-6]|div|tr|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 900);

  return {
    tag_name: tagName,
    name: title || tagName,
    html_url: releaseUrl,
    published_at: updated,
    body: plainBody,
    assets: [],
    _source: "github_atom",
  };
}

export function parseReleasesAtom(xml, fallbackRepoUrl = DEFAULT_REPO_URL) {
  const src = String(xml || "");
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  const parsed = [];
  let m;
  while ((m = entryRe.exec(src)) !== null && parsed.length < 20) {
    const item = parseSingleAtomEntry(m[1], fallbackRepoUrl);
    if (item && item.tag_name) parsed.push(item);
  }
  if (!parsed.length) return null;
  if (parsed.length === 1) return parsed[0];

  const isSemverTag = (tag) => /^v?\d+\.\d+\.\d+/i.test(String(tag || "").trim());
  const semverItems = parsed.filter((item) => isSemverTag(item.tag_name));
  if (!semverItems.length) return parsed[0];

  const stableItems = semverItems.filter((item) => !parseSemverParts(item.tag_name).pre);
  const pool = stableItems.length ? stableItems : semverItems;
  pool.sort((a, b) => compareSemver(b.tag_name, a.tag_name));
  return pool[0];
}

export class UpdateService {
  constructor({
    cachePath = getDefaultUpdateCachePath(),
    pluginRoot = DEFAULT_PLUGIN_ROOT,
    manifestPath = "",
    fetchJsonImpl = null,
    fetchTextImpl = null,
    getProxyUrl = null,
    getIgnoredVersion = null,
  } = {}) {
    this.cachePath = cachePath;
    this.pluginRoot = pluginRoot;
    this.manifestPath = manifestPath || path.join(pluginRoot, "plugin.json");
    this.fetchJsonImpl = fetchJsonImpl;
    this.fetchTextImpl = fetchTextImpl;
    this.getProxyUrl = typeof getProxyUrl === "function" ? getProxyUrl : () => "";
    this.getIgnoredVersion = typeof getIgnoredVersion === "function" ? getIgnoredVersion : () => "";
    this._inflightCheck = null;
  }

  _withNotificationState(res) {
    if (!res || typeof res !== "object") return res;
    let ignored = "";
    try {
      ignored = String(this.getIgnoredVersion?.() || "");
    } catch {}
    return {
      ...res,
      ...computeUpdateNotificationState(res, ignored),
    };
  }

  readManifest() {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return {
        name: "agy-family-ledger",
        version: "0.0.0",
        repository: { url: DEFAULT_REPO_URL },
      };
    }
  }

  getPluginMeta() {
    const mf = this.readManifest();
    const version = String(mf.version || "0.0.0");
    const rawRepoUrl = typeof mf.repository === "string" ? mf.repository : mf.repository?.url || mf.homepage;
    const repoUrl = String(rawRepoUrl || DEFAULT_REPO_URL).replace(/\.git$/i, "").replace(/\/+$/, "");
    const parsed = parseGithubRepo(repoUrl) || { owner: "Curelove", repo: "agy-family-ledger" };
    return {
      name: mf.name || "agy-family-ledger",
      version,
      repoUrl,
      releasesUrl: `${repoUrl}/releases`,
      owner: parsed.owner,
      repo: parsed.repo,
    };
  }

  _readCacheFile() {
    if (!this.cachePath) return null;
    try {
      if (!fs.existsSync(this.cachePath)) return null;
      return JSON.parse(fs.readFileSync(this.cachePath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return null;
    }
  }

  _writeCacheFile(obj) {
    if (!this.cachePath) return;
    const tmp = `${this.cachePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const payload = JSON.stringify(obj, null, 2) + "\n";
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, this.cachePath);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.writeFileSync(this.cachePath, payload, "utf8"); } catch {}
    }
  }

  getCachedResult() {
    const meta = this.getPluginMeta();
    const cached = this._readCacheFile();
    if (!cached || !cached.latestVersion) return null;
    const updateAvailable = compareSemver(cached.latestVersion, meta.version) > 0;
    const cleanSnippet = cached.bodySnippet ? decodeHtmlEntities(cached.bodySnippet) : "";
    return this._withNotificationState({
      ...cached,
      bodySnippet: cleanSnippet,
      currentVersion: meta.version,
      updateAvailable,
      repoUrl: meta.repoUrl,
      releasesUrl: meta.releasesUrl,
      fromCache: true,
    });
  }

  _resolveProxyUrl() {
    let explicit = "";
    try {
      explicit = String(this.getProxyUrl?.() || "");
    } catch {}
    return resolveConfiguredProxyUrl(explicit);
  }

  async _fetchGithubJson(url) {
    const proxyUrl = this._resolveProxyUrl();
    if (this.fetchJsonImpl) {
      return this.fetchJsonImpl(url, { proxyUrl });
    }
    return httpsGetJson(url, { proxyUrl, timeoutMs: 7500 });
  }

  async _fetchGithubText(url) {
    const proxyUrl = this._resolveProxyUrl();
    if (this.fetchTextImpl) {
      return this.fetchTextImpl(url, { proxyUrl });
    }
    return httpsGetText(url, {
      proxyUrl,
      timeoutMs: 7500,
      headers: { Accept: "application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.8" },
    });
  }

  async checkForUpdates({ force = false } = {}) {
    const meta = this.getPluginMeta();
    if (!force) {
      const cached = this.getCachedResult();
      if (
        cached &&
        cached.checkedAt &&
        Date.now() - Number(cached.checkedAt) < CACHE_TTL_MS &&
        cached.repoUrl === meta.repoUrl
      ) {
        return cached;
      }
    }
    if (this._inflightCheck) {
      return this._inflightCheck;
    }
    const run = this._performCheckForUpdates(meta).finally(() => {
      if (this._inflightCheck === run) this._inflightCheck = null;
    });
    this._inflightCheck = run;
    return run;
  }

  async _performCheckForUpdates(meta) {
    const latestApi = `https://api.github.com/repos/${meta.owner}/${meta.repo}/releases/latest`;
    const listApi = `https://api.github.com/repos/${meta.owner}/${meta.repo}/releases?per_page=1`;
    const atomUrl = `${meta.repoUrl}/releases.atom`;
    const checkedAt = Date.now();

    try {
      let release = null;
      let apiErr = null;
      try {
        release = await this._fetchGithubJson(latestApi);
      } catch (err) {
        if (err?.statusCode === 404) {
          const list = await this._fetchGithubJson(listApi).catch(() => null);
          if (Array.isArray(list) && list.length > 0) {
            release = list[0];
          }
        } else {
          apiErr = err;
        }
      }

      // GitHub API 限流 (403/429) 或失败时自动降级到公开 releases.atom 源
      let atomEmptyConfirmed = false;
      if (!release || !release.tag_name) {
        try {
          const atomXml = await this._fetchGithubText(atomUrl);
          const atomRelease = parseReleasesAtom(atomXml, meta.repoUrl);
          if (atomRelease && atomRelease.tag_name) {
            release = atomRelease;
            apiErr = null;
          } else {
            atomEmptyConfirmed = true;
            apiErr = null;
          }
        } catch (atomErr) {
          if (!apiErr) apiErr = atomErr;
        }
      }

      if (apiErr) throw apiErr;

      if (!release || !release.tag_name || atomEmptyConfirmed) {
        return this._withNotificationState({
          ok: false,
          noReleases: true,
          error: "GitHub 仓库暂未发布正式 Release",
          currentVersion: meta.version,
          repoUrl: meta.repoUrl,
          releasesUrl: meta.releasesUrl,
          checkedAt,
        });
      }

      const tagName = String(release.tag_name || "").trim();
      const latestVersion = tagName.replace(/^v/i, "");
      const bodyRaw = String(release.body || "");
      const bodySnippet = bodyRaw
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim()
        .slice(0, 900);
      const assets = Array.isArray(release.assets)
        ? release.assets.slice(0, 6).map((a) => ({
            name: String(a.name || ""),
            size: Number(a.size || 0),
            downloadUrl: String(a.browser_download_url || ""),
          }))
        : [];
      const zipAsset = assets.find((a) => /\.zip$/i.test(a.name) && a.downloadUrl);

      const result = {
        ok: true,
        source: release._source || "github_api",
        currentVersion: meta.version,
        latestVersion,
        tagName,
        releaseName: String(release.name || tagName),
        updateAvailable: compareSemver(latestVersion, meta.version) > 0,
        releaseUrl: String(release.html_url || meta.releasesUrl),
        zipDownloadUrl: zipAsset ? zipAsset.downloadUrl : "",
        zipAssetName: zipAsset ? zipAsset.name : "",
        publishedAt: String(release.published_at || ""),
        bodySnippet,
        assets,
        repoUrl: meta.repoUrl,
        releasesUrl: meta.releasesUrl,
        checkedAt,
        fromCache: false,
      };

      this._writeCacheFile(result);
      return this._withNotificationState(result);
    } catch (err) {
      const msg = String(err?.message || err || "网络请求失败");
      const hasProxy = Boolean(this._resolveProxyUrl());
      let friendlyErr = `无法连接 GitHub（${msg}）`;
      if (msg.includes("403") || msg.includes("429")) {
        friendlyErr = "GitHub API 请求频率受限，可稍后再试或直接打开 Releases 页面查看";
      } else if (!hasProxy && /超时|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
        friendlyErr = `连接 GitHub 超时（${msg}），若未开全局代理可在「连接配置」中填写本地 HTTP 代理后重试`;
      }
      return this._withNotificationState({
        ok: false,
        error: friendlyErr,
        currentVersion: meta.version,
        repoUrl: meta.repoUrl,
        releasesUrl: meta.releasesUrl,
        checkedAt,
      });
    }
  }
}
