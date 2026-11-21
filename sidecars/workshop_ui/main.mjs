/**
 * 创意工坊 (Plugin Workshop 2.0) Sidecar Backend
 * - 临时目录独立置于插件根目录上级的 workshop_tmp，彻底避免插件目录监控锁导致的 ENOTEMPTY
 * - 支持：精选分类目录 + GitHub 在线实时检索订阅 + 启用/停用切换 + 侧边栏 README 阅读 + 热重载/冷启动 + 运行环境依赖检测
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp, Response } from 'sidecar_sdk';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSHOP_ROOT = join(__dirname, '..', '..'); // <plugins>/workshop
const PLUGINS_DIR = join(WORKSHOP_ROOT, '..'); // <plugins>
const TMP_DIR = join(PLUGINS_DIR, '..', 'workshop_tmp'); // 独立临时缓存目录（位于 plugins 目录外，防文件锁）
const SUBS_PATH = join(WORKSHOP_ROOT, 'subscriptions.json');
const CATALOG_PATH = join(__dirname, 'catalog.json');
const HTML_PATH = join(__dirname, 'index.html');
const CONFIG_JSON_PATH = join(homedir(), '.gemini', 'config', 'config.json');

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

let cachedProxyInfo;
function getSystemProxyConfig() {
  if (cachedProxyInfo !== undefined) return cachedProxyInfo;
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  const parseProxy = (raw) => {
    const clean = String(raw || '').trim();
    if (!clean) return null;
    try {
      const u = new URL(clean.includes('://') ? clean : `http://${clean}`);
      if (u.hostname && u.port) return { host: u.hostname, port: Number(u.port) };
    } catch {}
    return null;
  };
  let found = parseProxy(envProxy);
  if (!found && process.platform === 'win32') {
    try {
      const out = execFileSync('reg.exe', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ], { encoding: 'utf-8', windowsHide: true, timeout: 1500 });
      const enabledMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
      const serverMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out);
      if (enabledMatch && parseInt(enabledMatch[1], 16) === 1 && serverMatch) {
        let srv = serverMatch[1].trim();
        if (srv.includes('=')) {
          const httpsPart = /https=([^;]+)/i.exec(srv) || /http=([^;]+)/i.exec(srv);
          if (httpsPart) srv = httpsPart[1];
        }
        found = parseProxy(srv);
      }
    } catch {}
  }
  cachedProxyInfo = found;
  return found;
}

function makeHttpsProxyAgent(proxy) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (opts, cb) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${opts.host}:${opts.port || 443}`,
    });
    req.setTimeout(6000, () => req.destroy(new Error('Proxy CONNECT timeout')));
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return cb(new Error(`Proxy CONNECT HTTP ${res.statusCode}`));
      }
      const tlsSock = tls.connect({ socket, servername: opts.servername || opts.host });
      cb(null, tlsSock);
    });
    req.once('error', (err) => cb(err));
    req.end();
  };
  return agent;
}

function requestViaHttpsProxy(targetUrl, { timeoutMs = 15000, headers = {}, maxRedirects = 5 } = {}) {
  const proxy = getSystemProxyConfig();
  if (!proxy) return null;
  return new Promise((resolve, reject) => {
    const visit = (curUrl, left) => {
      const u = new URL(curUrl);
      const mod = u.protocol === 'http:' ? http : https;
      const reqOpts = u.protocol === 'https:'
        ? { agent: makeHttpsProxyAgent(proxy), headers, timeout: timeoutMs }
        : { host: proxy.host, port: proxy.port, path: curUrl, headers: { ...headers, Host: u.host }, timeout: timeoutMs };
      const req = mod.request(u.protocol === 'https:' ? u : reqOpts, u.protocol === 'https:' ? reqOpts : undefined, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
          res.resume();
          return visit(new URL(res.headers.location, curUrl).href, left - 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, buffer: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
      req.on('error', reject);
      req.end();
    };
    visit(targetUrl, maxRedirects);
  });
}

async function smartHttpGet(url, { timeoutMs = 15000, headers = {}, preferProxy = true } = {}) {
  const tryProxy = async () => {
    const p = requestViaHttpsProxy(url, { timeoutMs, headers });
    if (!p) throw new Error('No system proxy');
    return await p;
  };
  const tryDirect = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
      const buffer = Buffer.from(await resp.arrayBuffer());
      return { ok: resp.ok, status: resp.status, buffer };
    } finally {
      clearTimeout(timer);
    }
  };
  if (preferProxy && getSystemProxyConfig()) {
    try { return await tryProxy(); } catch { return await tryDirect(); }
  }
  try { return await tryDirect(); } catch (e) {
    if (getSystemProxyConfig()) return await tryProxy();
    throw e;
  }
}

function writeJsonSafe(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
}

function safeRm(target) {
  if (!target || !existsSync(target)) return;
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  } catch {
    // Windows 下偶发占用句柄时，先改名移入 workshop_tmp 垃圾区再清理，确保不阻断安装
    try {
      mkdirSync(TMP_DIR, { recursive: true });
      const trash = join(TMP_DIR, `_trash_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      renameSync(target, trash);
      try {
        rmSync(trash, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } catch {}
    } catch {}
  }
}

function cleanupStaleTmp() {
  if (!existsSync(TMP_DIR)) return;
  try {
    const now = Date.now();
    for (const entry of readdirSync(TMP_DIR)) {
      const p = join(TMP_DIR, entry);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > 10 * 60 * 1000) {
          rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        }
      } catch {}
    }
  } catch {}
}

function getConfigPluginsMap() {
  const cfg = readJsonSafe(CONFIG_JSON_PATH, {});
  return cfg && typeof cfg.plugins === 'object' && cfg.plugins ? cfg.plugins : {};
}

const cmdExistsCache = new Map();
function commandExistsOnPath(cmd) {
  const clean = String(cmd || '').trim();
  if (!clean) return false;
  if (cmdExistsCache.has(clean)) return cmdExistsCache.get(clean);
  const pathDirs = String(process.env.PATH || '').split(';').filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  let found = false;
  for (const dir of pathDirs) {
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, clean + ext))) { found = true; break; }
      } catch {}
    }
    if (found) break;
  }
  cmdExistsCache.set(clean, found);
  return found;
}

const RUNTIME_INSTALL_HINTS = {
  npx: 'Node.js (npx)',
  npm: 'Node.js (npm)',
  node: 'Node.js',
  uvx: 'uv (uvx)',
  uv: 'uv',
  python: 'Python',
  python3: 'Python 3',
  docker: 'Docker Desktop',
};

function inspectPluginRuntime(pluginDir) {
  const capabilities = [];
  const missingDeps = [];
  const seenMissing = new Set();
  if (existsSync(join(pluginDir, 'skills'))) capabilities.push('Skills');
  if (existsSync(join(pluginDir, 'sidecars'))) capabilities.push('Sidecar');
  if (existsSync(join(pluginDir, 'rules'))) capabilities.push('Rules');

  let hasMcp = false;
  for (const cfgFile of ['mcp_config.json', 'mcp.json', 'gemini-extension.json']) {
    const cfg = readJsonSafe(join(pluginDir, cfgFile), null);
    const servers = cfg?.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    hasMcp = true;
    for (const [srvName, srv] of Object.entries(servers)) {
      const cmd = String(srv?.command || '').trim();
      if (!cmd) continue;
      if (cmd.startsWith('./') || cmd.startsWith('.\\') || /^[a-zA-Z]:\\/.test(cmd)) {
        const rel = cmd.replace(/^\.[\\/]/, '');
        if (!existsSync(join(pluginDir, rel)) && !existsSync(cmd) && !seenMissing.has(cmd)) {
          seenMissing.add(cmd);
          missingDeps.push({ server: srvName, command: cmd, label: `本地脚本缺失: ${cmd}` });
        }
        continue;
      }
      if (!commandExistsOnPath(cmd) && !seenMissing.has(cmd)) {
        seenMissing.add(cmd);
        missingDeps.push({
          server: srvName,
          command: cmd,
          label: RUNTIME_INSTALL_HINTS[cmd.toLowerCase()] || cmd,
        });
      }
    }
  }
  if (hasMcp) capabilities.push('MCP');
  return { capabilities, missingDeps };
}

function setPluginEnabledInConfig(pluginId, enabled) {
  const cfg = readJsonSafe(CONFIG_JSON_PATH, {});
  if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};
  cfg.plugins[pluginId] = { ...(cfg.plugins[pluginId] || {}), enabled: Boolean(enabled) };
  writeJsonSafe(CONFIG_JSON_PATH, cfg);
}

function getSubscriptions() {
  return readJsonSafe(SUBS_PATH, {});
}

function saveSubscription(pluginId, meta) {
  const subs = getSubscriptions();
  subs[pluginId] = {
    ...meta,
    id: pluginId,
    subscribedAt: new Date().toISOString(),
  };
  writeJsonSafe(SUBS_PATH, subs);
}

function removeSubscription(pluginId) {
  const subs = getSubscriptions();
  if (pluginId in subs) {
    delete subs[pluginId];
    writeJsonSafe(SUBS_PATH, subs);
  }
}

function getInstalledPlugins() {
  const result = [];
  if (!existsSync(PLUGINS_DIR)) return result;
  const cfgPlugins = getConfigPluginsMap();
  const subs = getSubscriptions();

  for (const name of readdirSync(PLUGINS_DIR)) {
    if (name.startsWith('.')) continue;
    const full = join(PLUGINS_DIR, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const pj = readJsonSafe(join(full, 'plugin.json'), {});
    const sub = subs[name] || {};
    const cfgEntry = cfgPlugins[name];
    const enabled = cfgEntry && typeof cfgEntry.enabled === 'boolean' ? cfgEntry.enabled : !pj.disabled;

    const { capabilities, missingDeps } = inspectPluginRuntime(full);

    result.push({
      id: name,
      displayName: sub.zhName || pj.displayName || pj.name || name,
      enName: sub.enName || pj.name || name,
      category: sub.category || '本地插件',
      platform: sub.platform || (pj.repository ? 'GitHub' : '本地目录'),
      risk: sub.risk || 'medium',
      riskNote: sub.riskNote || '请确认该插件来源可信后再启用工具。',
      description: sub.summary || pj.description || '',
      repo: sub.repo || (typeof pj.repository === 'string' ? pj.repository : pj.repository?.url) || '',
      docsUrl: sub.docsUrl || sub.repo || pj.homepage || '',
      subscribedAt: sub.subscribedAt || '',
      enabled,
      isSelf: name === 'workshop',
      path: full,
      capabilities,
      missingDeps,
    });
  }
  return result;
}

function sanitizeId(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 48);
}

function parseGithubUrl(rawUrl) {
  const clean = String(rawUrl || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const treeMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/i.exec(clean);
  if (treeMatch) {
    return {
      owner: treeMatch[1],
      repoName: treeMatch[2],
      repoBase: `https://github.com/${treeMatch[1]}/${treeMatch[2]}`,
      branch: treeMatch[3],
      subdir: treeMatch[4] || '',
    };
  }
  const baseMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(clean);
  if (baseMatch) {
    return {
      owner: baseMatch[1],
      repoName: baseMatch[2],
      repoBase: `https://github.com/${baseMatch[1]}/${baseMatch[2]}`,
      branch: '',
      subdir: '',
    };
  }
  return null;
}

function buildZipCandidates(repoUrl, branch = 'main', useMirror = true) {
  const parsed = parseGithubUrl(repoUrl);
  const clean = parsed ? parsed.repoBase : String(repoUrl || '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const effBranch = parsed?.branch || branch || 'main';
  const branches = [...new Set([effBranch, 'main', 'master'])];
  const urls = [];
  for (const b of branches) {
    const direct = `${clean}/archive/refs/heads/${b}.zip`;
    if (useMirror) {
      urls.push(`https://ghfast.top/${direct}`);
      urls.push(`https://gh-proxy.com/${direct}`);
    }
    urls.push(direct);
  }
  return { urls, parsed };
}

async function downloadToFile(url, destPath) {
  const isMirror = /ghfast\.top|gh-proxy\.com/i.test(url);
  const resp = await smartHttpGet(url, { timeoutMs: 35000, preferProxy: !isMirror });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const buf = resp.buffer;
  if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('下载内容不是有效的 ZIP 压缩包');
  }
  writeFileSync(destPath, buf);
  return buf.length;
}

async function installPluginFromSpec(spec) {
  const { id, zhName, enName, category, platform, risk, riskNote, summary, repo, docsUrl, subdir, branch, useMirror } = spec || {};
  const parsed = parseGithubUrl(repo);
  const pluginId = sanitizeId(id || parsed?.repoName || String(repo || '').split('/').pop());
  if (!pluginId || pluginId === 'workshop') {
    throw new Error('无效的插件 ID');
  }

  cleanupStaleTmp();
  mkdirSync(TMP_DIR, { recursive: true });
  const runId = `${pluginId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const zipPath = join(TMP_DIR, `${runId}.zip`);
  const extractDir = join(TMP_DIR, `${runId}_extract`);
  const targetDir = join(PLUGINS_DIR, pluginId);

  try {
    const { urls } = buildZipCandidates(repo, branch || 'main', useMirror !== false);
    let downloadedFrom = '';
    let lastErr = null;
    for (const url of urls) {
      try {
        await downloadToFile(url, zipPath);
        downloadedFrom = url;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!downloadedFrom) {
      throw new Error(`所有下载通道均失败：${lastErr?.message || '网络不可达'}`);
    }

    mkdirSync(extractDir, { recursive: true });
    if (process.platform === 'win32') {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ]);
    } else {
      await execFileAsync('unzip', ['-oq', zipPath, '-d', extractDir]);
    }

    const roots = readdirSync(extractDir).filter((n) => {
      try { return statSync(join(extractDir, n)).isDirectory(); } catch { return false; }
    });
    if (roots.length === 0) {
      throw new Error('压缩包解压后为空');
    }
    let srcRoot = join(extractDir, roots[0]);
    const effSubdir = subdir || parsed?.subdir || '';
    if (effSubdir) {
      const sub = join(srcRoot, ...effSubdir.split('/').filter(Boolean));
      if (existsSync(sub) && statSync(sub).isDirectory()) {
        srcRoot = sub;
      }
    }

    // 彻底清理目标旧目录（遇到文件锁时自动改名迁移后再覆盖）
    safeRm(targetDir);
    cpSync(srcRoot, targetDir, { recursive: true, force: true });

    // 若缺少 Antigravity 标准 plugin.json，自动补全
    const pjPath = join(targetDir, 'plugin.json');
    if (!existsSync(pjPath)) {
      const meta = {
        name: pluginId,
        displayName: zhName || enName || pluginId,
        description: summary || `从 ${repo} 订阅安装的插件`,
        repository: parsed ? parsed.repoBase : repo,
      };
      writeFileSync(pjPath, JSON.stringify(meta, null, 2), 'utf-8');
    }

    saveSubscription(pluginId, {
      zhName: zhName || enName || pluginId,
      enName: enName || pluginId,
      category: category || 'GitHub 订阅',
      platform: platform || 'GitHub · 社区开源',
      risk: risk || 'medium',
      riskNote: riskNote || '来自 GitHub 社区仓库，安装前建议查阅源码与依赖说明。',
      summary: summary || '',
      repo: parsed ? parsed.repoBase : repo,
      docsUrl: docsUrl || repo,
      subdir: effSubdir,
      branch: branch || parsed?.branch || 'main',
    });
    setPluginEnabledInConfig(pluginId, true);
    const { capabilities, missingDeps } = inspectPluginRuntime(targetDir);

    return {
      ok: true,
      id: pluginId,
      targetDir,
      downloadedFrom,
      capabilities,
      missingDeps,
    };
  } finally {
    safeRm(zipPath);
    safeRm(extractDir);
  }
}

const CAT_QUERY_HINTS = {
  'Agent 增强': 'mcp-agent OR agent-skills OR mcp-prompt',
  '资源检索': 'mcp-arxiv OR mcp-fetch OR mcp-search',
  '记忆上下文': 'mcp-memory OR mcp-obsidian OR mem0-mcp',
  '通道通知': 'mcp-telegram OR mcp-discord OR mcp-slack',
  '工具集成': 'mcp-browser OR playwright-mcp OR mcp-sqlite',
  '趣味互动': 'spotify-mcp OR manim-mcp OR mcp-image',
  '资源导航': 'awesome-mcp-servers OR awesome-claude-skills',
};

const TRANSLATE_CACHE = new Map();

async function translateSingleText(text, tl = 'zh-CN') {
  const clean = String(text || '').trim();
  if (!clean) return clean;
  const key = `${tl}::${clean}`;
  if (TRANSLATE_CACHE.has(key)) return TRANSLATE_CACHE.get(key);

  let result = '';
  try {
    const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(clean)}`;
    const resp = await smartHttpGet(gUrl, { timeoutMs: 8000, headers: { 'User-Agent': 'Mozilla/5.0' }, preferProxy: true });
    if (resp.ok) {
      const json = JSON.parse(resp.buffer.toString('utf-8'));
      if (Array.isArray(json?.[0])) {
        result = json[0].map((seg) => (Array.isArray(seg) ? seg[0] || '' : '')).join('');
      }
    }
  } catch {}

  if (!result) {
    try {
      const mUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean.slice(0, 480))}&langpair=en|${encodeURIComponent(tl)}`;
      const resp = await smartHttpGet(mUrl, { timeoutMs: 6000, preferProxy: false });
      if (resp.ok) {
        const json = JSON.parse(resp.buffer.toString('utf-8'));
        const txt = json?.responseData?.translatedText || '';
        if (txt && !/MYMEMORY WARNING/i.test(txt)) {
          result = txt;
        }
      }
    } catch {}
  }

  const finalOut = result || clean;
  if (TRANSLATE_CACHE.size > 2000) TRANSLATE_CACHE.clear();
  if (result) TRANSLATE_CACHE.set(key, finalOut);
  return finalOut;
}

async function translateMarkdownSafe(md, tl = 'zh-CN') {
  const src = String(md || '');
  // 保留代码块不翻译，仅按段落分批翻译说明文字
  const blocks = [];
  let masked = src.replace(/```[\s\S]*?```/g, (m) => {
    const idx = blocks.length;
    blocks.push(m);
    return `\n\n__CODE_BLOCK_${idx}__\n\n`;
  });

  const paras = masked.split(/\n{2,}/);
  const outParas = [];
  // 并发 5 路分块翻译（限制在 40 段以内确保秒级响应）
  const chunksToProcess = paras.slice(0, 60);
  const restParas = paras.slice(60);

  for (let i = 0; i < chunksToProcess.length; i += 10) {
    const batch = chunksToProcess.slice(i, i + 10);
    const translated = await Promise.all(
      batch.map(async (p) => {
        const trimmed = p.trim();
        if (!trimmed || /^__CODE_BLOCK_\d+__$/.test(trimmed) || !/[A-Za-z]{2,}/.test(trimmed)) {
          return p;
        }
        // 分行合并翻译（单段超过 1400 字符截断分段）
        if (trimmed.length > 1400) {
          const half = Math.floor(trimmed.length / 2);
          const p1 = await translateSingleText(trimmed.slice(0, half), tl);
          const p2 = await translateSingleText(trimmed.slice(half), tl);
          return p1 + ' ' + p2;
        }
        return await translateSingleText(trimmed, tl);
      }),
    );
    outParas.push(...translated);
  }
  if (restParas.length > 0) {
    outParas.push('', '> *(下文过长已保留原文，如需继续阅读可点击右上角「浏览器直达」)*', ...restParas);
  }

  let joined = outParas.join('\n\n');
  joined = joined.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => blocks[Number(i)] || '');
  return joined;
}

function classifyGithubRepo(item, requestedCat) {
  if (requestedCat && requestedCat !== '全部') return requestedCat;
  const text = `${item.name} ${item.description || ''} ${(item.topics || []).join(' ')}`.toLowerCase();
  if (/awesome|curated|list|collection/.test(text)) return '资源导航';
  if (/telegram|discord|slack|twitter|facebook|qq|wechat|lark|feishu|gmail|email|notify|whatsapp/.test(text)) return '通道通知';
  if (/memory|mem0|obsidian|knowledge|rag|context|note/.test(text)) return '记忆上下文';
  if (/wallpaper|pet|shimeji|story|meme|emoji|music|spotify|manim|game|anime/.test(text)) return '趣味互动';
  if (/arxiv|fetch|docs|search|crawl|scrape|pdf|ocr/.test(text)) return '资源检索';
  if (/skill|agent|prompt|workflow|thinking|orchestrat/.test(text)) return 'Agent 增强';
  return '工具集成';
}

const app = new SidecarApp();

app.page('/', () => {
  return new Response(readFileSync(HTML_PATH, 'utf-8'), {
    contentType: 'text/html; charset=utf-8',
  });
});

app.api('/api/catalog', () => {
  const catalog = readJsonSafe(CATALOG_PATH, []);
  const installed = getInstalledPlugins();
  const installedMap = new Map(installed.map((x) => [x.id, x]));
  const items = catalog.map((item) => {
    const inst = installedMap.get(item.id);
    return {
      ...item,
      installed: Boolean(inst),
      enabled: inst ? inst.enabled : false,
    };
  });
  return {
    pluginsDir: PLUGINS_DIR,
    items,
    installed,
  };
}, 'GET');

app.api('/api/search-github', async (query) => {
  try {
    const q = String(query?.q || '').trim();
    const cat = String(query?.cat || '').trim();
    const page = Math.max(1, Math.min(20, parseInt(query?.page || '1', 10) || 1));
    const perPage = 20;
    const autoTranslate = query?.autoTranslate !== '0';
    const tl = String(query?.tl || 'zh-CN');
    const installedIds = new Set(getInstalledPlugins().map((x) => x.id));

    let searchExpr = q ? `${q} mcp OR skill` : (CAT_QUERY_HINTS[cat] || 'mcp server');

    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchExpr)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
    const resp = await smartHttpGet(url, {
      timeoutMs: 15000,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'antigravity-workshop/2.0',
      },
      preferProxy: true,
    });

    if (!resp.ok) {
      return { ok: false, error: `GitHub 搜索接口返回 HTTP ${resp.status}（可能触发匿名限流，可稍后再试或直接粘贴仓库链接）` };
    }
    const data = JSON.parse(resp.buffer.toString('utf-8'));
    const officialOrgs = new Set(['modelcontextprotocol', 'anthropics', 'microsoft', 'github', 'cloudflare', 'google', 'chromedevtools', 'larksuite', 'upstash', 'tavily-ai', 'mem0ai']);

    const rawItems = (data.items || []).map((r) => {
      const ownerLower = String(r.owner?.login || '').toLowerCase();
      const isOfficial = officialOrgs.has(ownerLower);
      const id = sanitizeId(r.name);
      const assignedCat = classifyGithubRepo(r, cat);
      const origDesc = r.description || '';
      return {
        id,
        zhName: r.name,
        enName: r.full_name,
        category: assignedCat,
        platform: isOfficial ? 'GitHub · 知名/官方组织' : 'GitHub · 社区开源',
        risk: isOfficial ? 'low' : 'medium',
        riskNote: isOfficial
          ? '来源知名组织仓库，风险较低；仍建议运行前确认所需环境变量与权限。'
          : '社区开源项目（未经过人工逐行审计），订阅安装前建议在侧边栏查看 README 与源码。',
        summaryOrig: origDesc || '暂无仓库简介，可点击在侧边栏查看 README 原文。',
        summary: origDesc || '暂无仓库简介，可点击在侧边栏查看 README 原文。',
        repo: r.html_url,
        docsUrl: r.html_url,
        branch: r.default_branch || 'main',
        stars: r.stargazers_count || 0,
        language: r.language || '',
        tags: ['GitHub实时', ...(r.language ? [r.language] : []), `★${r.stargazers_count || 0}`],
        installed: installedIds.has(id),
        fromGithubSearch: true,
      };
    });

    if (autoTranslate && tl && tl !== 'orig') {
      await Promise.all(
        rawItems.map(async (it) => {
          if (it.summaryOrig && /[A-Za-z]{2,}/.test(it.summaryOrig) && !/[\u4e00-\u9fff]/.test(it.summaryOrig)) {
            it.summaryZh = await translateSingleText(it.summaryOrig, tl);
            it.summary = it.summaryZh;
          }
        }),
      );
    }

    const totalCount = data.total_count || rawItems.length;
    const hasMore = page * perPage < Math.min(totalCount, 1000) && rawItems.length === perPage;
    return { ok: true, page, perPage, hasMore, totalCount, items: rawItems };
  } catch (e) {
    return { ok: false, error: '连接 GitHub 搜索失败：' + String(e?.message || e) };
  }
}, 'GET');

app.api('/api/translate', async (body) => {
  try {
    const tl = String(body?.tl || 'zh-CN');
    if (typeof body?.markdown === 'string') {
      const translated = await translateMarkdownSafe(body.markdown, tl);
      return { ok: true, markdown: translated };
    }
    if (Array.isArray(body?.texts)) {
      const out = await Promise.all(body.texts.map((t) => translateSingleText(t, tl)));
      return { ok: true, texts: out };
    }
    if (typeof body?.text === 'string') {
      const out = await translateSingleText(body.text, tl);
      return { ok: true, text: out };
    }
    return { ok: false, error: '缺少待翻译内容' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, 'POST');

app.api('/api/install', async (body) => {
  try {
    return await installPluginFromSpec(body || {});
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, 'POST');

app.api('/api/toggle', (body) => {
  try {
    const pluginId = sanitizeId(body?.id);
    if (!pluginId || pluginId === 'workshop') {
      return { ok: false, error: '无法禁用创意工坊自身' };
    }
    setPluginEnabledInConfig(pluginId, Boolean(body?.enabled));
    return { ok: true, id: pluginId, enabled: Boolean(body?.enabled) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, 'POST');

app.api('/api/uninstall', (body) => {
  try {
    const pluginId = sanitizeId(body?.id);
    if (!pluginId || pluginId === 'workshop') {
      return { ok: false, error: '无法卸载创意工坊自身或无效插件' };
    }
    const targetDir = join(PLUGINS_DIR, pluginId);
    if (existsSync(targetDir)) {
      safeRm(targetDir);
    }
    removeSubscription(pluginId);
    return { ok: true, id: pluginId };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, 'POST');

app.api('/api/open-dir', () => {
  try {
    mkdirSync(PLUGINS_DIR, { recursive: true });
    if (process.platform === 'win32') execFile('explorer.exe', [PLUGINS_DIR]);
    else if (process.platform === 'darwin') execFile('open', [PLUGINS_DIR]);
    else execFile('xdg-open', [PLUGINS_DIR]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, 'POST');

app.api('/api/reload-self', () => {
  setTimeout(() => process.exit(0), 180);
  return { ok: true };
}, 'POST');

app.api('/api/cold-restart', () => {
  try {
    if (process.platform !== 'win32') {
      return { ok: false, error: '当前系统暂不支持自动冷启动，请手动退出并重开 Google Antigravity。' };
    }
    const localApp = process.env.LOCALAPPDATA || '';
    const agyExe = join(localApp, 'Programs', 'antigravity', 'Antigravity.exe');
    if (!existsSync(agyExe)) {
      return { ok: false, error: '未找到 Antigravity.exe: ' + agyExe };
    }
    const psScript = [
      'Start-Sleep -Milliseconds 600',
      'Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue | Stop-Process -Force',
      'while (Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }',
      `Start-Process -FilePath '${agyExe.replace(/'/g, "''")}'`,
    ].join('; ');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psScript],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, 'POST');

app.api('/api/readme', async (query) => {
  try {
    const repo = String(query?.repo || '').trim();
    const parsed = parseGithubUrl(repo);
    if (!parsed) {
      return { ok: false, error: '仅支持在侧边栏预览 GitHub 仓库文档，请点击右上角直达浏览器查看。' };
    }
    const subdir = String(query?.subdir || parsed.subdir || '').trim().replace(/^\/+|\/+$/g, '');
    const branch = String(query?.branch || parsed.branch || 'main').trim();
    const useMirror = query?.useMirror !== 'false';
    const branches = [...new Set([branch, 'main', 'master'])];
    const readmePaths = subdir ? [`${subdir}/README.md`, `${subdir}/readme.md`, 'README.md'] : ['README.md', 'readme.md'];

    const urls = [];
    for (const b of branches) {
      for (const rp of readmePaths) {
        const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repoName}/${b}/${rp}`;
        if (useMirror) {
          urls.push(`https://ghfast.top/${rawUrl}`);
          urls.push(`https://gh-proxy.com/${rawUrl}`);
        }
        urls.push(rawUrl);
      }
    }

    for (const u of urls) {
      try {
        const isMirror = /ghfast\.top|gh-proxy\.com/i.test(u);
        const resp = await smartHttpGet(u, { timeoutMs: 12000, preferProxy: !isMirror });
        if (resp.ok) {
          const text = resp.buffer.toString('utf-8');
          if (text && !text.trimStart().startsWith('<!DOCTYPE html')) {
            return { ok: true, content: text.slice(0, 40000), sourceUrl: u };
          }
        }
      } catch {
        // try next
      }
    }
    return { ok: false, error: '无法在线拉取 README（可能被限流或仓库无 README），可点击右上角在浏览器直达仓库。' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, 'GET');

app.run();
