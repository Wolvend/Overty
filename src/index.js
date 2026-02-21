#!/usr/bin/env node
'use strict';

/**
 * overty: Minimal MCP stdio server for Chrome DevTools Protocol (CDP).
 *
 * Transport: newline-delimited JSON-RPC (one JSON object per line).
 * CDP: Node.js built-in fetch + WebSocket (Node v22+).
 *
 * Tools:
 * - connect
 * - navigate
 * - wait_for_network_idle
 * - execute_js
 * - set_css
 * - install_css
 * - uninstall_css
 * - list_installed_css
 * - take_screenshot
 * - screenshot_element
 * - take_dom_snapshot
 * - assert_layout
 * - visual_diff
 * - qa_matrix
 * - render_html_mockups
 * - capture_bundle
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'overty', version: '0.1.0' };
const DEBUG = process.env.OVERTY_DEBUG === '1';

const DEFAULT_BROWSER_URL = process.env.OVERTY_BROWSER_URL || 'http://127.0.0.1:9222';
const OVERTY_WITH_CHROME_DEVTOOLS = process.env.OVERTY_WITH_CHROME_DEVTOOLS === '1' || process.env.OVERTY_WITH_CHROME_DEVTOOLS === 'true';

const OVERTY_CHROME_DEVTOOLS_EXEC = process.env.OVERTY_CHROME_DEVTOOLS_EXEC || process.execPath || 'node';
const OVERTY_CHROME_DEVTOOLS_DEFAULT_CMD = path.resolve(__dirname, '..', '..', 'chrome-devtools-mcp', 'build', 'src', 'index.js');
const OVERTY_CHROME_DEVTOOLS_CMD =
  process.env.OVERTY_CHROME_DEVTOOLS_CMD ||
  (isNodeExecutable(OVERTY_CHROME_DEVTOOLS_EXEC)
    ? OVERTY_CHROME_DEVTOOLS_DEFAULT_CMD
    : '');
const OVERTY_CHROME_DEVTOOLS_ARGS = parseChromeDevtoolsArgs(process.env.OVERTY_CHROME_DEVTOOLS_ARGS || '');
const OVERTY_CHROME_DEVTOOLS_START_DELAY_MS = Number.parseInt(process.env.OVERTY_CHROME_DEVTOOLS_START_DELAY_MS || '1500', 10);

const DEFAULT_SCREENSHOT_DIR =
  process.env.OVERTY_SCREENSHOT_DIR ||
  path.resolve(process.cwd(), 'output', 'overty', 'screenshots');

const DEFAULT_MOCKUP_DIR =
  process.env.OVERTY_MOCKUP_DIR || path.resolve(process.cwd(), 'output', 'overty', 'mockups');

const DEFAULT_BUNDLE_DIR =
  process.env.OVERTY_BUNDLE_DIR || path.resolve(process.cwd(), 'output', 'overty', 'bundles');
const DEFAULT_MATRIX_DIR =
  process.env.OVERTY_MATRIX_DIR || path.resolve(process.cwd(), 'output', 'overty', 'qa-matrix');
const DEFAULT_DIFF_DIR =
  process.env.OVERTY_DIFF_DIR || path.resolve(process.cwd(), 'output', 'overty', 'diffs');
const SAFE_OUTPUT_DIRS = (() => {
  const roots = [
    DEFAULT_SCREENSHOT_DIR,
    DEFAULT_MOCKUP_DIR,
    DEFAULT_BUNDLE_DIR,
    DEFAULT_MATRIX_DIR,
    DEFAULT_DIFF_DIR,
  ].map((value) => path.resolve(String(value || '').trim()));

  const seen = new Set();
  const deduped = [];
  for (const root of roots) {
    if (!root) continue;
    if (!seen.has(root)) {
      seen.add(root);
      deduped.push(root);
    }
  }

  return deduped;
})();

const MAX_INLINE_SCREENSHOT_BYTES = 2_000_000; // keep responses reasonably sized
const DEFAULT_STYLE_ID = 'overty-style';
const CHROME_DEVTOOLS_MCP_PROCESS = OVERTY_WITH_CHROME_DEVTOOLS
  ? {
      exec: OVERTY_CHROME_DEVTOOLS_EXEC,
      command: OVERTY_CHROME_DEVTOOLS_CMD,
      args: OVERTY_CHROME_DEVTOOLS_ARGS,
    }
  : null;
let chromeDevtoolsProcess = null;
let chromeDevtoolsStartupLogged = false;

function parseChromeDevtoolsArgs(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];

  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
  } catch (_err) {
    // Fall back to shell-like tokenization.
  }

  const tokenRe = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\\S+)/g;
  const matches = s.match(tokenRe);
  if (!matches) return [];
  return matches.map((token) => {
    if (
      (token[0] === '"' && token[token.length - 1] === '"') ||
      (token[0] === "'" && token[token.length - 1] === "'")
    ) {
      const body = token.slice(1, -1);
      return body.replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    return token;
  });
}

function isNodeExecutable(execPathOrName) {
  const normalized = String(execPathOrName || '').toLowerCase();
  const base = path.basename(normalized);
  return base === 'node' || base === 'node.exe' || base === 'nodejs' || /[/\\]node(?:\.exe)?$/.test(normalized);
}

function spawnChromeDevtoolsMcpChild() {
  if (!CHROME_DEVTOOLS_MCP_PROCESS) return null;
  const scriptPath = String(CHROME_DEVTOOLS_MCP_PROCESS.command || '').trim();
  const execPath = String(CHROME_DEVTOOLS_MCP_PROCESS.exec || '').trim();
  const isNodeLaunch = isNodeExecutable(execPath);
  if (isNodeLaunch && !scriptPath) {
    log('OVERTY_WITH_CHROME_DEVTOOLS set with Node executable but no sidecar command configured; skipping child launch.');
    return null;
  }

  const args = [...CHROME_DEVTOOLS_MCP_PROCESS.args];
  if (scriptPath) {
    args.unshift(scriptPath);
  }

  const proc = spawn(CHROME_DEVTOOLS_MCP_PROCESS.exec, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.on('exit', (code, signal) => {
    const suffix = code !== null ? `exit ${code}` : `signal ${signal || 'unknown'}`;
    log(`chrome-devtools-mcp child ${suffix}`);
  });
  proc.on('error', (err) => {
    log('Failed to spawn chrome-devtools-mcp child:', err && err.message ? err.message : err);
  });
  if (proc.stderr) {
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (!text) return;
      log(`[chrome-devtools-mcp] ${text}`);
    });
  }

  return { proc, args };
}

async function startChromeDevtoolsMcpChild() {
  if (!CHROME_DEVTOOLS_MCP_PROCESS) return;
  if (chromeDevtoolsProcess) return;
  const child = spawnChromeDevtoolsMcpChild();
  if (!child || !child.proc) return;
  chromeDevtoolsProcess = child.proc;
  const startupArgs = child.args || [];

  const delayMs = Number.isFinite(OVERTY_CHROME_DEVTOOLS_START_DELAY_MS) && OVERTY_CHROME_DEVTOOLS_START_DELAY_MS > 0
    ? Math.floor(OVERTY_CHROME_DEVTOOLS_START_DELAY_MS)
    : 0;
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  if (chromeDevtoolsProcess.exitCode !== null) {
    chromeDevtoolsProcess = null;
    throw new Error(`chrome-devtools-mcp child exited during startup for ${OVERTY_CHROME_DEVTOOLS_CMD}`);
  }

  if (!chromeDevtoolsStartupLogged) {
    const formattedCommand = [CHROME_DEVTOOLS_MCP_PROCESS.exec, ...startupArgs].map((arg) => JSON.stringify(String(arg))).join(' ');
    log(`Started chrome-devtools-mcp sidecar: ${formattedCommand}`);
    chromeDevtoolsStartupLogged = true;
  }
}

async function shutdownChromeDevtoolsMcpChild() {
  if (!chromeDevtoolsProcess) return;
  const proc = chromeDevtoolsProcess;
  chromeDevtoolsProcess = null;

  if (!proc.killed) {
    proc.removeAllListeners('exit');
    const exited = new Promise((resolve) => {
      proc.once('exit', () => resolve());
    });
    proc.kill('SIGTERM');
    const timeout = sleep(2_000).then(() => 'timeout');
    await Promise.race([exited, timeout]);
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
    }
  }
}

function log(...args) {
  // Never write logs to stdout; MCP uses stdout for protocol messages.
  console.error('[overty]', ...args);
}

function debugLog(...args) {
  if (!DEBUG) return;
  console.error('[overty:debug]', ...args);
}

function nowFileSafe() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeFileBase(name) {
  const s = String(name || '').trim() || 'variant';
  // Keep it ASCII-ish and filesystem-friendly.
  const cleaned = s
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  return cleaned.slice(0, 80) || 'variant';
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mimeFromPath(filePath, fallback = 'image/png') {
  const ext = String(path.extname(String(filePath || '')).toLowerCase());
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return fallback;
}

function dataUrlFromBuffer(buf, mimeType) {
  const mime = mimeType && String(mimeType).trim() ? String(mimeType).trim() : 'application/octet-stream';
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

function parsePngDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = s.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

function summarizeEvents(events, limitErrors = 8) {
  const out = {
    console: { total: 0, error: 0, warning: 0, info: 0 },
    exception: { total: 0 },
    log: { total: 0, error: 0, warning: 0, info: 0 },
    errors: [],
  };

  const pushErr = (e) => {
    if (out.errors.length >= limitErrors) return;
    out.errors.push({
      type: e.type,
      level: e.level || null,
      text: e.text || '',
      location: e.location || null,
      seq: e.seq,
    });
  };

  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'console') {
      out.console.total += 1;
      const lvl = String(e.level || 'log').toLowerCase();
      if (lvl === 'error') out.console.error += 1;
      else if (lvl === 'warning' || lvl === 'warn') out.console.warning += 1;
      else out.console.info += 1;
      if (lvl === 'error') pushErr(e);
      continue;
    }
    if (e.type === 'exception') {
      out.exception.total += 1;
      pushErr(e);
      continue;
    }
    if (e.type === 'log') {
      out.log.total += 1;
      const lvl = String(e.level || 'info').toLowerCase();
      if (lvl === 'error') out.log.error += 1;
      else if (lvl === 'warning' || lvl === 'warn') out.log.warning += 1;
      else out.log.info += 1;
      if (lvl === 'error') pushErr(e);
    }
  }

  return out;
}

function buildMockupsIndexHtml(opts) {
  const title = escapeHtml(opts && opts.title ? opts.title : 'overty mockups');
  const createdAt = escapeHtml(opts && opts.createdAt ? opts.createdAt : new Date().toISOString());
  const outputDir = escapeHtml(opts && opts.outputDir ? opts.outputDir : '');
  const results = Array.isArray(opts && opts.results ? opts.results : null) ? opts.results : [];
  const failures = Array.isArray(opts && opts.failures ? opts.failures : null) ? opts.failures : [];

  const cards = results
    .map((r) => {
      const name = escapeHtml(r.name || '');
      const imgFile = r.fileName ? String(r.fileName) : (r.filePath ? path.basename(String(r.filePath)) : '');
      const htmlFile = r.htmlFileName ? String(r.htmlFileName) : (r.htmlPath ? path.basename(String(r.htmlPath)) : '');
      const hasImg = !!imgFile;
      const imgSrc = hasImg ? `./${encodeURIComponent(imgFile)}` : '';
      const htmlHref = htmlFile ? `./${encodeURIComponent(htmlFile)}` : '';
      const bytes = Number.isFinite(r.bytes) ? `${Math.floor(r.bytes)} bytes` : '';
      const ev = r.eventSummary
        ? `console ${r.eventSummary.console.total} (err ${r.eventSummary.console.error}), exceptions ${r.eventSummary.exception.total}`
        : '';

      const links = [hasImg ? `<a class="link" href="${imgSrc}">png</a>` : null, htmlFile ? `<a class="link" href="${htmlHref}">html</a>` : null]
        .filter(Boolean)
        .join(' ');

      return `
        <section class="card">
          <header class="card-h">
            <div class="name">${name}</div>
            <div class="meta">${escapeHtml(bytes)}${ev ? ` · ${escapeHtml(ev)}` : ''}</div>
            <div class="links">${links}</div>
          </header>
          <div class="shot">
            ${hasImg ? `<a href="${imgSrc}"><img loading="lazy" src="${imgSrc}" alt="${name} screenshot"></a>` : '<div class="missing">missing screenshot</div>'}
          </div>
        </section>
      `.trim();
    })
    .join('\n');

  const failuresBlock = failures.length
    ? `
      <details class="failures" open>
        <summary>Failures (${failures.length})</summary>
        <ul>
          ${failures
            .map((f) => `<li><code>${escapeHtml(f.name || '')}</code>: ${escapeHtml(f.error || '')}</li>`)
            .join('\n')}
        </ul>
      </details>
    `.trim()
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root { color-scheme: light dark; }
      html, body { margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      body { background: #0b0d12; color: #eaf0ff; }
      a { color: inherit; }
      .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
      .top { display: flex; gap: 16px; justify-content: space-between; align-items: baseline; flex-wrap: wrap; }
      .top h1 { font-size: 18px; letter-spacing: .02em; margin: 0; }
      .top .sub { opacity: .75; font-size: 12px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 18px; }
      .card { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.09); border-radius: 14px; overflow: hidden; }
      .card-h { padding: 12px 12px 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
      .name { font-weight: 650; font-size: 14px; }
      .meta { opacity: .75; font-size: 12px; margin-top: 4px; }
      .links { opacity: .9; font-size: 12px; margin-top: 6px; display: flex; gap: 10px; flex-wrap: wrap; }
      .link { text-decoration: none; border-bottom: 1px dashed rgba(255,255,255,.35); }
      .shot { padding: 10px; }
      img { width: 100%; height: auto; display: block; border-radius: 10px; background: rgba(0,0,0,.18); }
      .missing { opacity: .6; padding: 28px 10px; text-align: center; }
      .failures { margin-top: 14px; padding: 10px 12px; border: 1px solid rgba(255,255,255,.10); border-radius: 12px; background: rgba(255,70,70,.08); }
      .failures summary { cursor: pointer; }
      .failures ul { margin: 10px 0 0 18px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <h1>${title}</h1>
        <div class="sub">created ${createdAt}${outputDir ? ` · ${outputDir}` : ''}</div>
      </div>
      ${failuresBlock}
      <div class="grid">
        ${cards}
      </div>
    </div>
  </body>
</html>
`;
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteFileSync(filePath, data) {
  ensureDirSync(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  if (h === '127.0.0.1') return true;
  // Accept 127.0.0.0/8 as loopback.
  if (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(h)) return true;
  return false;
}

function parseHttpUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('Empty URL');
  const withProto = s.includes('://') ? s : `http://${s}`;
  const url = new URL(withProto);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid protocol: ${url.protocol}`);
  }
  return url;
}

function toCdpHttpBase(browserUrl) {
  const base = String(browserUrl || '').trim().replace(/\/$/, '');
  return base;
}

function isSafeOutputPath(resolvedPath) {
  const p = path.resolve(String(resolvedPath || ''));
  if (!p) return false;
  if (p === path.parse(p).root) return false;

  const safeRoots = SAFE_OUTPUT_DIRS;
  for (const root of safeRoots) {
    const rel = path.relative(root, p);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }

  return false;
}

function resolveSafeOutputPath(rawPath) {
  const input = String(rawPath || '').trim();
  if (!input) return null;
  if (input.includes('\0')) return null;

  const resolved = path.resolve(process.cwd(), input);
  return isSafeOutputPath(resolved) ? resolved : null;
}

function sleep(ms) {
  const t = Math.max(0, Math.floor(Number(ms) || 0));
  return new Promise((resolve) => setTimeout(resolve, t));
}

function getRemoteObjectValue(remoteObject) {
  if (!remoteObject || typeof remoteObject !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(remoteObject, 'value')) return remoteObject.value;
  return undefined;
}

async function httpFetchJson(url, method = 'GET') {
  const res = await fetch(url, { method });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}`);
    err.status = res.status;
    try {
      err.body = await res.text();
    } catch {
      err.body = null;
    }
    throw err;
  }
  return await res.json();
}

async function httpFetchText(url, method = 'GET') {
  const res = await fetch(url, { method });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}`);
    err.status = res.status;
    try {
      err.body = await res.text();
    } catch {
      err.body = null;
    }
    throw err;
  }
  return await res.text();
}

function requireLoopbackUnlessAllowed(browserUrl, allowRemote) {
  const u = typeof browserUrl === 'string' ? parseHttpUrl(browserUrl) : browserUrl;
  if (!allowRemote && !isLoopbackHost(u.hostname)) {
    return {
      ok: false,
      error: { code: 'OVERTY_REMOTE_NOT_ALLOWED', message: `Refusing non-loopback host: ${u.hostname}` },
    };
  }
  return { ok: true, url: u };
}

async function cdpHttpNewPage(opts) {
  const guard = requireLoopbackUnlessAllowed(opts.browserUrl, opts.allowRemote);
  if (!guard.ok) return guard;

  const base = toCdpHttpBase(guard.url.toString());
  const pageUrl = String(opts.url || 'about:blank');
  const endpoint = `${base}/json/new?${encodeURIComponent(pageUrl)}`;

  try {
    // Newer Chrome versions require PUT for /json/new; older versions accept GET.
    let json;
    try {
      json = await httpFetchJson(endpoint, 'PUT');
    } catch (err) {
      if (err && err.status === 405) {
        json = await httpFetchJson(endpoint, 'GET');
      } else {
        throw err;
      }
    }
    if (!json || typeof json !== 'object' || typeof json.id !== 'string') {
      return { ok: false, error: { code: 'OVERTY_CDP_ERROR', message: `Unexpected response from ${endpoint}` } };
    }
    return {
      ok: true,
      target: {
        id: json.id,
        type: json.type,
        title: json.title,
        url: json.url,
        webSocketDebuggerUrl: json.webSocketDebuggerUrl,
      },
    };
  } catch (err) {
    return { ok: false, error: { code: 'OVERTY_CDP_UNREACHABLE', message: `Could not open new page via ${endpoint}`, details: String(err) } };
  }
}

async function cdpHttpActivate(opts) {
  const guard = requireLoopbackUnlessAllowed(opts.browserUrl, opts.allowRemote);
  if (!guard.ok) return guard;
  const base = toCdpHttpBase(guard.url.toString());
  const targetId = String(opts.targetId || '').trim();
  if (!targetId) {
    return { ok: false, error: { code: 'OVERTY_INVALID_ARG', message: 'Missing required argument: targetId' } };
  }
  const endpoint = `${base}/json/activate/${encodeURIComponent(targetId)}`;
  try {
    const text = await httpFetchText(endpoint, 'GET');
    return { ok: true, result: text.trim() };
  } catch (err) {
    return { ok: false, error: { code: 'OVERTY_CDP_ERROR', message: `Could not activate target ${targetId}`, details: String(err) } };
  }
}

async function cdpHttpClose(opts) {
  const guard = requireLoopbackUnlessAllowed(opts.browserUrl, opts.allowRemote);
  if (!guard.ok) return guard;
  const base = toCdpHttpBase(guard.url.toString());
  const targetId = String(opts.targetId || '').trim();
  if (!targetId) {
    return { ok: false, error: { code: 'OVERTY_INVALID_ARG', message: 'Missing required argument: targetId' } };
  }
  const endpoint = `${base}/json/close/${encodeURIComponent(targetId)}`;
  try {
    const text = await httpFetchText(endpoint, 'GET');
    return { ok: true, result: text.trim() };
  } catch (err) {
    return { ok: false, error: { code: 'OVERTY_CDP_ERROR', message: `Could not close target ${targetId}`, details: String(err) } };
  }
}

function buildSetCssExpression(styleId, css, mode) {
  const id = styleId && String(styleId).trim() ? String(styleId).trim() : DEFAULT_STYLE_ID;
  const cssText = String(css || '');
  const action = mode === 'append' ? 'append' : 'replace';
  return `(() => {
    const id = ${JSON.stringify(id)};
    const css = ${JSON.stringify(cssText)};
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      (document.head || document.documentElement).appendChild(el);
    }
    if (${JSON.stringify(action)} === 'append') {
      el.textContent = (el.textContent || '') + '\\n' + css;
    } else {
      el.textContent = css;
    }
    return { styleId: id, length: (el.textContent || '').length };
  })()`;
}

function buildRemoveStyleExpression(styleId) {
  const id = styleId && String(styleId).trim() ? String(styleId).trim() : DEFAULT_STYLE_ID;
  return `(() => {
    const id = ${JSON.stringify(id)};
    const el = document.getElementById(id);
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
      return { removed: true, styleId: id };
    }
    return { removed: false, styleId: id };
  })()`;
}

function buildSetHtmlExpression(html) {
  const htmlText = String(html || '');
  return `(() => {
    document.open();
    document.write(${JSON.stringify(htmlText)});
    document.close();
    return true;
  })()`;
}

function buildAuditLayoutExpression(tolerancePx, maxElements) {
  const tol = Number.isFinite(tolerancePx) ? Math.max(0, Math.floor(tolerancePx)) : 1;
  const max = Number.isFinite(maxElements) ? Math.max(1, Math.floor(maxElements)) : 30;
  return `(() => {
            const tol = ${tol};
            const max = ${max};
            const de = document.documentElement;
            const vw = de ? de.clientWidth : window.innerWidth;
            const vh = de ? de.clientHeight : window.innerHeight;
            const scrollW = de ? de.scrollWidth : vw;
            const scrollH = de ? de.scrollHeight : vh;
            const horizOverflow = scrollW > vw + tol;
            const offenders = [];
            const nodes = document.querySelectorAll('body *');
            for (let i = 0; i < nodes.length && offenders.length < max; i++) {
              const el = nodes[i];
              const r = el.getBoundingClientRect();
              if (!r || r.width <= 0 || r.height <= 0) continue;
              if (r.right > vw + tol || r.left < -tol) {
                const tag = (el.tagName || '').toLowerCase();
                const id = el.id ? String(el.id) : null;
                const cls = el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 3).join(' ') : null;
                const selector = id ? ('#' + id) : (cls ? (tag + '.' + cls.split(/\\s+/)[0]) : tag);
                offenders.push({
                  selector,
                  tag,
                  id,
                  class: cls,
                  rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
                });
              }
            }
            const suggestions = [];
            if (horizOverflow) {
              suggestions.push('Horizontal overflow detected. Common quick fix: body { overflow-x: hidden; }');
              suggestions.push('Find the overflowing element(s) and apply max-width: 100vw or clamp widths.');
            }
            return {
              viewport: { width: vw, height: vh },
              document: { scrollWidth: scrollW, scrollHeight: scrollH, horizontalOverflow: horizOverflow },
              overflowingElements: offenders,
              suggestions,
            };
          })()`;
}

function normalizeAssertLayoutRules(raw) {
  const rules = raw && typeof raw === 'object' ? raw : {};
  const toNum = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const toInt = (v, fallback, min, max) => {
    const n = Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fallback;
    const lo = Number.isFinite(min) ? min : n;
    const hi = Number.isFinite(max) ? max : n;
    return Math.max(lo, Math.min(hi, n));
  };

  return {
    overflowTolerancePx: toInt(rules.overflowTolerancePx, 1, 0),
    maxHorizontalOverflowPx: toInt(rules.maxHorizontalOverflowPx, 0, 0),
    maxOverflowingElements: toInt(rules.maxOverflowingElements, 0, 0),
    maxClippedText: toInt(rules.maxClippedText, 0, 0),
    maxOverlapCount: toInt(rules.maxOverlapCount, 0, 0),
    maxTapTargetViolations: toInt(rules.maxTapTargetViolations, 0, 0),
    minTapTargetPx: toNum(rules.minTapTargetPx, 44),
    overlapTolerancePx: toNum(rules.overlapTolerancePx, 2),
    maxElements: toInt(rules.maxElements, 30, 1),
    overlapCandidateLimit: toInt(rules.overlapCandidateLimit, 120, 10),
    overlapSelector:
      typeof rules.overlapSelector === 'string' && rules.overlapSelector.trim()
        ? rules.overlapSelector.trim()
        : 'body *',
    includeOverlaps: rules.includeOverlaps !== false,
  };
}

function buildAssertLayoutExpression(rawRules) {
  const rules = normalizeAssertLayoutRules(rawRules);
  return `(() => {
            const rules = ${JSON.stringify(rules)};
            const de = document.documentElement;
            const vw = de ? de.clientWidth : window.innerWidth;
            const vh = de ? de.clientHeight : window.innerHeight;
            const scrollW = de ? de.scrollWidth : vw;
            const scrollH = de ? de.scrollHeight : vh;
            const overflowPx = Math.max(0, scrollW - vw);
            const tol = rules.overflowTolerancePx;

            const pickSelector = (el) => {
              const tag = (el && el.tagName ? String(el.tagName).toLowerCase() : 'node');
              const id = el && el.id ? String(el.id) : '';
              if (id) return '#' + id;
              const cls = el && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean)[0] : '';
              return cls ? (tag + '.' + cls) : tag;
            };

            const toRect = (r) => ({
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
            });

            const isVisible = (el) => {
              if (!el || !el.getBoundingClientRect) return false;
              const r = el.getBoundingClientRect();
              if (!r || r.width <= 0 || r.height <= 0) return false;
              return true;
            };

            const overflowingElements = [];
            const allNodes = document.querySelectorAll('body *');
            for (let i = 0; i < allNodes.length && overflowingElements.length < rules.maxElements; i++) {
              const el = allNodes[i];
              if (!isVisible(el)) continue;
              const r = el.getBoundingClientRect();
              if (r.right > vw + tol || r.left < -tol) {
                overflowingElements.push({
                  selector: pickSelector(el),
                  rect: toRect(r),
                });
              }
            }

            const clippedText = [];
            const textNodes = document.querySelectorAll('p,span,a,button,label,li,td,th,h1,h2,h3,h4,h5,h6,input,textarea');
            for (let i = 0; i < textNodes.length && clippedText.length < rules.maxElements; i++) {
              const el = textNodes[i];
              if (!isVisible(el)) continue;
              const text = (el.value && typeof el.value === 'string') ? el.value.trim() : ((el.innerText && typeof el.innerText === 'string') ? el.innerText.trim() : '');
              if (!text) continue;
              const cs = window.getComputedStyle(el);
              const clipX = el.scrollWidth > el.clientWidth + 1;
              const clipY = el.scrollHeight > el.clientHeight + 1;
              const ox = String(cs.overflowX || '').toLowerCase();
              const oy = String(cs.overflowY || '').toLowerCase();
              const hidesOverflow = ['hidden', 'clip', 'auto', 'scroll'].includes(ox) || ['hidden', 'clip', 'auto', 'scroll'].includes(oy);
              if ((clipX || clipY) && hidesOverflow) {
                clippedText.push({
                  selector: pickSelector(el),
                  textSample: text.slice(0, 120),
                  clientWidth: el.clientWidth,
                  scrollWidth: el.scrollWidth,
                  clientHeight: el.clientHeight,
                  scrollHeight: el.scrollHeight,
                  overflowX: ox,
                  overflowY: oy,
                });
              }
            }

            const tapTargetsUnderMin = [];
            const interactive = document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]');
            for (let i = 0; i < interactive.length && tapTargetsUnderMin.length < rules.maxElements; i++) {
              const el = interactive[i];
              if (!isVisible(el)) continue;
              const r = el.getBoundingClientRect();
              if (r.width < rules.minTapTargetPx || r.height < rules.minTapTargetPx) {
                tapTargetsUnderMin.push({
                  selector: pickSelector(el),
                  width: r.width,
                  height: r.height,
                });
              }
            }

            let overlapCount = 0;
            const overlapSamples = [];
            if (rules.includeOverlaps) {
              const overlapNodes = document.querySelectorAll(rules.overlapSelector || 'body *');
              const candidates = [];
              for (let i = 0; i < overlapNodes.length && candidates.length < rules.overlapCandidateLimit; i++) {
                const el = overlapNodes[i];
                if (!isVisible(el)) continue;
                const r = el.getBoundingClientRect();
                candidates.push({ el, selector: pickSelector(el), rect: r });
              }

              for (let i = 0; i < candidates.length; i++) {
                const a = candidates[i];
                for (let j = i + 1; j < candidates.length; j++) {
                  const b = candidates[j];
                  if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
                  const left = Math.max(a.rect.left, b.rect.left);
                  const right = Math.min(a.rect.right, b.rect.right);
                  const top = Math.max(a.rect.top, b.rect.top);
                  const bottom = Math.min(a.rect.bottom, b.rect.bottom);
                  const w = right - left;
                  const h = bottom - top;
                  if (w > rules.overlapTolerancePx && h > rules.overlapTolerancePx) {
                    overlapCount += 1;
                    if (overlapSamples.length < rules.maxElements) {
                      overlapSamples.push({
                        a: a.selector,
                        b: b.selector,
                        intersection: { width: w, height: h, left, top },
                      });
                    }
                  }
                }
              }
            }

            const violations = [];
            if (overflowPx > rules.maxHorizontalOverflowPx) {
              violations.push({
                code: 'HORIZONTAL_OVERFLOW_PX',
                actual: overflowPx,
                limit: rules.maxHorizontalOverflowPx,
              });
            }
            if (overflowingElements.length > rules.maxOverflowingElements) {
              violations.push({
                code: 'OVERFLOWING_ELEMENTS',
                actual: overflowingElements.length,
                limit: rules.maxOverflowingElements,
              });
            }
            if (clippedText.length > rules.maxClippedText) {
              violations.push({
                code: 'CLIPPED_TEXT',
                actual: clippedText.length,
                limit: rules.maxClippedText,
              });
            }
            if (overlapCount > rules.maxOverlapCount) {
              violations.push({
                code: 'OVERLAPS',
                actual: overlapCount,
                limit: rules.maxOverlapCount,
              });
            }
            if (tapTargetsUnderMin.length > rules.maxTapTargetViolations) {
              violations.push({
                code: 'TAP_TARGETS_UNDER_MIN',
                actual: tapTargetsUnderMin.length,
                limit: rules.maxTapTargetViolations,
                minTapTargetPx: rules.minTapTargetPx,
              });
            }

            const suggestions = [];
            if (violations.some((v) => v.code === 'HORIZONTAL_OVERFLOW_PX' || v.code === 'OVERFLOWING_ELEMENTS')) {
              suggestions.push('Investigate overflow offenders and constrain widths to viewport bounds.');
            }
            if (violations.some((v) => v.code === 'CLIPPED_TEXT')) {
              suggestions.push('Review text containers with clipping/overflow styles and improve responsive wrapping.');
            }
            if (violations.some((v) => v.code === 'OVERLAPS')) {
              suggestions.push('Review stacking/positioning rules for overlapping elements.');
            }
            if (violations.some((v) => v.code === 'TAP_TARGETS_UNDER_MIN')) {
              suggestions.push('Increase hit area for interactive elements (recommended minimum: 44px).');
            }

            return {
              pass: violations.length === 0,
              rules,
              metrics: {
                viewport: { width: vw, height: vh },
                document: { scrollWidth: scrollW, scrollHeight: scrollH, horizontalOverflowPx: overflowPx },
                overflowingElements: overflowingElements.length,
                clippedText: clippedText.length,
                overlapCount,
                tapTargetsUnderMin: tapTargetsUnderMin.length,
              },
              samples: {
                overflowingElements,
                clippedText,
                overlaps: overlapSamples,
                tapTargetsUnderMin,
              },
              violations,
              suggestions,
            };
          })()`;
}

function buildVisualDiffExpression(opts) {
  const baselineDataUrl = String(opts && opts.baselineDataUrl ? opts.baselineDataUrl : '');
  const candidateDataUrl = String(opts && opts.candidateDataUrl ? opts.candidateDataUrl : '');
  const threshold = Number.isFinite(opts && opts.threshold) ? Math.max(0, Math.min(255, Number(opts.threshold))) : 16;
  const includeDiff = !(opts && opts.includeDiff === false);

  return `(async () => {
            const baselineSrc = ${JSON.stringify(baselineDataUrl)};
            const candidateSrc = ${JSON.stringify(candidateDataUrl)};
            const threshold = ${threshold};
            const includeDiff = ${includeDiff ? 'true' : 'false'};
            if (!baselineSrc || !candidateSrc) throw new Error('Missing baseline or candidate image source.');

            const loadImage = (src) =>
              new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('Could not load image data.'));
                img.src = src;
              });

            const [baseline, candidate] = await Promise.all([loadImage(baselineSrc), loadImage(candidateSrc)]);
            const bw = baseline.naturalWidth || baseline.width;
            const bh = baseline.naturalHeight || baseline.height;
            const cw = candidate.naturalWidth || candidate.width;
            const ch = candidate.naturalHeight || candidate.height;
            const width = Math.min(bw, cw);
            const height = Math.min(bh, ch);
            if (!width || !height) throw new Error('Invalid image dimensions for diff.');

            const cBase = document.createElement('canvas');
            cBase.width = width;
            cBase.height = height;
            const ctxBase = cBase.getContext('2d', { willReadFrequently: true });
            ctxBase.drawImage(baseline, 0, 0, width, height);
            const baseData = ctxBase.getImageData(0, 0, width, height);

            const cCand = document.createElement('canvas');
            cCand.width = width;
            cCand.height = height;
            const ctxCand = cCand.getContext('2d', { willReadFrequently: true });
            ctxCand.drawImage(candidate, 0, 0, width, height);
            const candData = ctxCand.getImageData(0, 0, width, height);

            const cDiff = document.createElement('canvas');
            cDiff.width = width;
            cDiff.height = height;
            const ctxDiff = cDiff.getContext('2d', { willReadFrequently: true });
            const diffData = ctxDiff.createImageData(width, height);

            let diffPixels = 0;
            let maxDelta = 0;
            let sumDelta = 0;
            for (let i = 0; i < baseData.data.length; i += 4) {
              const dr = Math.abs(baseData.data[i] - candData.data[i]);
              const dg = Math.abs(baseData.data[i + 1] - candData.data[i + 1]);
              const db = Math.abs(baseData.data[i + 2] - candData.data[i + 2]);
              const da = Math.abs(baseData.data[i + 3] - candData.data[i + 3]);
              const delta = Math.max(dr, dg, db, da);
              if (delta > maxDelta) maxDelta = delta;
              sumDelta += (dr + dg + db + da) / 4;

              if (delta > threshold) {
                diffPixels += 1;
                diffData.data[i] = 255;
                diffData.data[i + 1] = 64;
                diffData.data[i + 2] = 64;
                diffData.data[i + 3] = 255;
              } else {
                const g = Math.round(candData.data[i] * 0.299 + candData.data[i + 1] * 0.587 + candData.data[i + 2] * 0.114);
                diffData.data[i] = g;
                diffData.data[i + 1] = g;
                diffData.data[i + 2] = g;
                diffData.data[i + 3] = 255;
              }
            }
            ctxDiff.putImageData(diffData, 0, 0);

            const comparedPixels = width * height;
            return {
              baselineDimensions: { width: bw, height: bh },
              candidateDimensions: { width: cw, height: ch },
              comparedDimensions: { width, height },
              comparedPixels,
              diffPixels,
              diffPercent: comparedPixels ? (diffPixels * 100) / comparedPixels : 0,
              meanDelta: comparedPixels ? sumDelta / comparedPixels : 0,
              maxDelta,
              threshold,
              dimensionMismatch: bw !== cw || bh !== ch,
              diffDataUrl: includeDiff ? cDiff.toDataURL('image/png') : null,
            };
          })()`;
}

function injectStyleIntoHtml(html, css, styleId) {
  const doc = String(html || '');
  const cssText = String(css || '');
  const id = styleId && String(styleId).trim() ? String(styleId).trim() : DEFAULT_STYLE_ID;
  const styleTag = `<style id="${id}">\n${cssText}\n</style>\n`;

  if (/<\/head>/i.test(doc)) {
    return doc.replace(/<\/head>/i, styleTag + '</head>');
  }
  if (/<head[^>]*>/i.test(doc)) {
    return doc.replace(/<head[^>]*>/i, (m) => `${m}\n${styleTag}`);
  }
  return styleTag + doc;
}

function jsonRpcError(id, code, message, data) {
  const err = { jsonrpc: '2.0', error: { code, message } };
  if (typeof id === 'string' || typeof id === 'number') {
    err.id = id;
  }
  if (data !== undefined) err.error.data = data;
  return err;
}

function toolError(code, message, details) {
  const err = {
    error: {
      code,
      message,
    },
  };
  if (details !== undefined) err.error.details = details;
  return {
    content: [{ type: 'text', text: `[${code}] ${message}` }],
    structuredContent: err,
    isError: true,
  };
}

class JsonRpcLineServer {
  constructor(handler) {
    this._handler = handler;
    this._buffer = '';
    this._queue = Promise.resolve();
  }

  start() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => this._onData(chunk));
    process.stdin.on('error', (err) => log('stdin error', err));
    process.stdin.resume();
  }

  send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  _onData(chunk) {
    this._buffer += chunk;

    // Process complete lines.
    while (true) {
      const idx = this._buffer.indexOf('\n');
      if (idx === -1) break;

      let line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.send(jsonRpcError(null, -32700, 'Parse error', String(err && err.message ? err.message : err)));
        continue;
      }

      this._enqueueMessage(msg);
    }
  }

  _enqueueMessage(msg) {
    this._queue = this._queue
      .then(() => this._handleMessage(msg))
      .catch((err) => {
        log('message queue error', err);
      });
  }

  async _handleMessage(msg) {
    const hasRequestId = Object.prototype.hasOwnProperty.call(msg || {}, 'id');
    const requestId = hasRequestId ? msg.id : null;

    if (!msg || msg.jsonrpc !== '2.0') {
      this.send(jsonRpcError(requestId, -32600, 'Invalid Request'));
      return;
    }

    // We only handle requests + notifications from the client.
    if (typeof msg.method !== 'string') {
      if (hasRequestId) {
        this.send(jsonRpcError(requestId, -32600, 'Invalid Request'));
      }
      return;
    }

    const isRequest = hasRequestId;
    if (!isRequest) {
      // Notification; best-effort handle, no response.
      try {
        await this._handler(msg);
      } catch (err) {
        log('notification handler error', err);
      }
      return;
    }

    try {
      const result = await this._handler(msg);
      this.send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      // Protocol-level failure.
      const code = err && err._mcpCode ? err._mcpCode : -32603;
      const message = err && err.message ? err.message : String(err);
      this.send(jsonRpcError(msg.id, code, code === -32603 ? 'Internal error' : message, code === -32603 ? message : undefined));
    }
  }
}

class CdpSession {
  constructor() {
    this._ws = null;
    this._pending = new Map();
    this._nextId = 1;
    this._selectedTarget = null;
    this._browserUrl = null;
    this._events = [];
    this._eventSeq = 0;
    this._maxEvents = 500;
    this._installedCss = new Map(); // styleId -> { identifier, mode, length }
    this._networkEnabled = false;
    this._networkInFlight = new Map(); // requestId -> { url, type, tsStart }
  }

  get isConnected() {
    return !!this._ws && this._ws.readyState === 1 /* OPEN */;
  }

  get selectedTarget() {
    return this._selectedTarget;
  }

  get browserUrl() {
    return this._browserUrl;
  }

  async disconnect() {
    for (const [, p] of this._pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('CDP disconnected'));
    }
    this._pending.clear();
    this._installedCss.clear();
    this._networkEnabled = false;
    this._networkInFlight.clear();

    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        // ignore
      }
    }
    this._ws = null;
    this._selectedTarget = null;
  }

  async connect(opts) {
    const browserUrl = parseHttpUrl(opts.browserUrl || DEFAULT_BROWSER_URL);

    if (!opts.allowRemote && !isLoopbackHost(browserUrl.hostname)) {
      return {
        ok: false,
        error: { code: 'OVERTY_REMOTE_NOT_ALLOWED', message: `Refusing non-loopback host: ${browserUrl.hostname}` },
      };
    }

    const targetsRes = await this._listTargets(browserUrl);
    if (!targetsRes.ok) return targetsRes;

    const targets = targetsRes.targets;
    if (targets.length === 0) {
      return { ok: false, error: { code: 'OVERTY_NO_TARGETS', message: 'No debuggable targets found' } };
    }

    const selected = selectTarget(targets, opts);
    if (!selected) {
      return { ok: false, error: { code: 'OVERTY_TARGET_NOT_FOUND', message: 'No target matched the selection criteria' } };
    }

    debugLog('connect selecting target', { id: selected.id, type: selected.type, title: selected.title, url: selected.url });

    await this.disconnect();
    await this._connectWebSocket(selected.webSocketDebuggerUrl);
    this._browserUrl = browserUrl.toString().replace(/\/$/, '');
    this._selectedTarget = selected;

    // Minimal domain enables for common operations.
    await this._send('Page.enable');
    await this._send('Runtime.enable');
    await this._send('DOM.enable');
    try {
      await this._send('Log.enable');
    } catch {
      // Some targets may not support Log domain; ignore.
    }

    if (opts.navigateUrl) {
      await this._send('Page.navigate', { url: String(opts.navigateUrl) });
    }

    return { ok: true, targets, selectedTarget: selected, browserUrl: this._browserUrl };
  }

  _pushEvent(evt) {
    this._eventSeq += 1;
    const item = { seq: this._eventSeq, ts: Date.now(), ...evt };
    this._events.push(item);
    if (this._events.length > this._maxEvents) {
      this._events.splice(0, this._events.length - this._maxEvents);
    }
  }

  listEvents(opts) {
    const sinceSeq = Number.isFinite(opts.sinceSeq) ? Math.max(0, Math.floor(opts.sinceSeq)) : 0;
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50;
    const types = Array.isArray(opts.types) ? opts.types.map(String) : null;

    let events = this._events.filter((e) => e.seq > sinceSeq);
    if (types && types.length) {
      events = events.filter((e) => types.includes(e.type));
    }
    if (events.length > limit) {
      events = events.slice(events.length - limit);
    }

    if (opts.clear) {
      this._events = [];
      this._eventSeq = 0;
    }

    return { ok: true, events };
  }

  _stringifyRemoteArg(arg) {
    if (!arg || typeof arg !== 'object') return String(arg);
    if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
      const v = arg.value;
      if (typeof v === 'string') return v;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    if (typeof arg.description === 'string') return arg.description;
    if (typeof arg.type === 'string') return `[${arg.type}]`;
    return '[arg]';
  }

  _onCdpEvent(method, params) {
    try {
      if (this._networkEnabled) {
        if (method === 'Network.requestWillBeSent') {
          const requestId = params && typeof params.requestId === 'string' ? params.requestId : null;
          if (!requestId) return;
          const req = params && params.request && typeof params.request === 'object' ? params.request : null;
          const url = req && typeof req.url === 'string' ? req.url : null;
          const type = params && typeof params.type === 'string' ? params.type : 'Other';
          this._networkInFlight.set(requestId, { url, type, tsStart: Date.now() });
          return;
        }

        if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
          const requestId = params && typeof params.requestId === 'string' ? params.requestId : null;
          if (!requestId) return;
          this._networkInFlight.delete(requestId);
          return;
        }
      }

      if (method === 'Runtime.consoleAPICalled') {
        const type = params && params.type ? String(params.type) : 'log';
        const args = Array.isArray(params && params.args) ? params.args : [];
        const text = args.map((a) => this._stringifyRemoteArg(a)).join(' ');
        const stack = params && params.stackTrace && Array.isArray(params.stackTrace.callFrames) ? params.stackTrace.callFrames : [];
        const top = stack[0] || null;
        this._pushEvent({
          type: 'console',
          level: type,
          text: text.slice(0, 4000),
          location: top
            ? {
                url: top.url || null,
                lineNumber: Number.isFinite(top.lineNumber) ? top.lineNumber : null,
                columnNumber: Number.isFinite(top.columnNumber) ? top.columnNumber : null,
                functionName: top.functionName || null,
              }
            : null,
        });
        return;
      }

      if (method === 'Runtime.exceptionThrown') {
        const details = params && params.exceptionDetails ? params.exceptionDetails : null;
        const ex = details && details.exception ? details.exception : null;
        const description =
          ex && typeof ex.description === 'string'
            ? ex.description
            : details && typeof details.text === 'string'
              ? details.text
              : 'Exception';
        const url = details && typeof details.url === 'string' ? details.url : null;
        const lineNumber = details && Number.isFinite(details.lineNumber) ? details.lineNumber : null;
        const columnNumber = details && Number.isFinite(details.columnNumber) ? details.columnNumber : null;
        this._pushEvent({
          type: 'exception',
          level: 'error',
          text: String(description).slice(0, 4000),
          location: { url, lineNumber, columnNumber },
        });
        return;
      }

      if (method === 'Log.entryAdded') {
        const entry = params && params.entry ? params.entry : null;
        if (!entry || typeof entry !== 'object') return;
        this._pushEvent({
          type: 'log',
          level: entry.level ? String(entry.level) : 'info',
          text: entry.text ? String(entry.text).slice(0, 4000) : '',
          location: {
            url: entry.url ? String(entry.url) : null,
            lineNumber: Number.isFinite(entry.lineNumber) ? entry.lineNumber : null,
          },
        });
      }
    } catch {
      // Never allow event parsing to break the CDP response path.
    }
  }

  async evaluate(expression, options) {
    const awaitPromise = options.awaitPromise !== false;
    const returnByValue = options.returnByValue !== false;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000;

    let res;
    try {
      res = await this._send(
        'Runtime.evaluate',
        {
          expression: String(expression),
          awaitPromise,
          returnByValue,
        },
        { timeoutMs },
      );
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const isContextLost =
        msg.includes('Execution context was destroyed') || msg.includes('Cannot find context') || msg.includes('Cannot find execution context');
      return {
        ok: false,
        error: {
          code: isContextLost ? 'OVERTY_JS_CONTEXT_LOST' : 'OVERTY_CDP_ERROR',
          message: isContextLost ? 'JavaScript execution context lost (page navigated/reloaded)' : 'CDP Runtime.evaluate failed',
          details: msg,
        },
      };
    }

    if (res && res.exceptionDetails) {
      return {
        ok: false,
        error: {
          code: 'OVERTY_JS_EXCEPTION',
          message: 'JavaScript exception',
          details: res.exceptionDetails,
        },
      };
    }

    return { ok: true, result: res && res.result ? res.result : null };
  }

  async outerHtml(selector, maxChars, timeoutMs) {
    const sel = selector ? String(selector) : '';
    const expr = sel
      ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.outerHTML : null; })()`
      : `(() => document.documentElement ? document.documentElement.outerHTML : null)()`;
    const evalRes = await this.evaluate(expr, { returnByValue: true, awaitPromise: true, timeoutMs });
    if (!evalRes.ok) return evalRes;

    const html = evalRes.result && Object.prototype.hasOwnProperty.call(evalRes.result, 'value') ? evalRes.result.value : null;
    if (typeof html !== 'string') {
      return { ok: true, html: null, truncated: false, chars: 0 };
    }

    const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 200_000;
    if (html.length <= limit) return { ok: true, html, truncated: false, chars: html.length };
    return { ok: true, html: html.slice(0, limit), truncated: true, chars: html.length };
  }

  async screenshot(opts) {
    const format = String(opts.format || 'png').toLowerCase();
    if (!['png', 'jpeg', 'webp'].includes(format)) {
      return { ok: false, error: { code: 'OVERTY_INVALID_ARG', message: `Unsupported format: ${format}` } };
    }

    const quality =
      opts.quality === undefined || opts.quality === null
        ? undefined
        : Math.max(0, Math.min(100, Math.floor(Number(opts.quality))));

    const fullPage = !!opts.fullPage;

    let clip;
    let captureBeyondViewport;
    if (fullPage) {
      try {
        const metrics = await this._send('Page.getLayoutMetrics');
        if (metrics && metrics.contentSize) {
          clip = {
            x: 0,
            y: 0,
            width: metrics.contentSize.width,
            height: metrics.contentSize.height,
            scale: 1,
          };
          captureBeyondViewport = true;
        }
      } catch {
        // If layout metrics fail, fall back to viewport capture.
      }
    }

    let res;
    try {
      res = await this._send('Page.captureScreenshot', {
        format,
        ...(quality !== undefined && format !== 'png' ? { quality } : {}),
        fromSurface: true,
        ...(captureBeyondViewport ? { captureBeyondViewport } : {}),
        ...(clip ? { clip } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        error: { code: 'OVERTY_CDP_ERROR', message: 'CDP captureScreenshot failed', details: String(err && err.message ? err.message : err) },
      };
    }

    if (!res || typeof res.data !== 'string') {
      return { ok: false, error: { code: 'OVERTY_CDP_ERROR', message: 'CDP did not return screenshot data' } };
    }

    return { ok: true, format, base64: res.data };
  }

  async screenshotClip(opts) {
    const format = String(opts.format || 'png').toLowerCase();
    if (!['png', 'jpeg', 'webp'].includes(format)) {
      return { ok: false, error: { code: 'OVERTY_INVALID_ARG', message: `Unsupported format: ${format}` } };
    }

    const quality =
      opts.quality === undefined || opts.quality === null
        ? undefined
        : Math.max(0, Math.min(100, Math.floor(Number(opts.quality))));

    const x = Number(opts.x);
    const y = Number(opts.y);
    const width = Number(opts.width);
    const height = Number(opts.height);
    if (![x, y, width, height].every((n) => Number.isFinite(n))) {
      return { ok: false, error: { code: 'OVERTY_INVALID_ARG', message: 'clip x/y/width/height must be finite numbers' } };
    }
    if (width <= 0 || height <= 0) {
      return { ok: false, error: { code: 'OVERTY_INVALID_ARG', message: 'clip width/height must be > 0' } };
    }

    const clip = {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width,
      height,
      scale: 1,
    };

    let res;
    try {
      res = await this._send('Page.captureScreenshot', {
        format,
        ...(quality !== undefined && format !== 'png' ? { quality } : {}),
        fromSurface: true,
        captureBeyondViewport: true,
        clip,
      });
    } catch (err) {
      return {
        ok: false,
        error: { code: 'OVERTY_CDP_ERROR', message: 'CDP captureScreenshot failed', details: String(err && err.message ? err.message : err) },
      };
    }

    if (!res || typeof res.data !== 'string') {
      return { ok: false, error: { code: 'OVERTY_CDP_ERROR', message: 'CDP did not return screenshot data' } };
    }

    return { ok: true, format, base64: res.data, clip };
  }

  async setViewport(opts) {
    const width = Math.floor(Number(opts.width));
    const height = Math.floor(Number(opts.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { ok: false, error: { code: 'OVERTY_INVALID_ARG', message: 'viewport width/height must be positive integers' } };
    }
    const deviceScaleFactor = opts.deviceScaleFactor === undefined ? 1 : Number(opts.deviceScaleFactor);
    const mobile = !!opts.mobile;

    await this._send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? deviceScaleFactor : 1,
      mobile,
    });

    return { ok: true, width, height, deviceScaleFactor, mobile };
  }

  async clearViewport() {
    await this._send('Emulation.clearDeviceMetricsOverride');
    return { ok: true };
  }

  listInstalledCss() {
    const installs = [];
    for (const [styleId, meta] of this._installedCss.entries()) {
      installs.push({
        styleId,
        identifier: meta && typeof meta.identifier === 'string' ? meta.identifier : null,
        mode: meta && typeof meta.mode === 'string' ? meta.mode : 'replace',
        length: meta && Number.isFinite(meta.length) ? meta.length : null,
      });
    }
    return { ok: true, installs };
  }

  async installCss(opts) {
    const styleId = opts && typeof opts.styleId === 'string' && opts.styleId.trim() ? opts.styleId.trim() : DEFAULT_STYLE_ID;
    const css = opts && typeof opts.css === 'string' ? opts.css : '';
    const mode = opts && opts.mode === 'append' ? 'append' : 'replace';

    const prev = this._installedCss.get(styleId) || null;
    if (prev && prev.identifier) {
      try {
        await this._send('Page.removeScriptToEvaluateOnNewDocument', { identifier: prev.identifier });
      } catch {
        // Best-effort cleanup; continue.
      }
      this._installedCss.delete(styleId);
    }

    let identifier = null;
    try {
      const res = await this._send('Page.addScriptToEvaluateOnNewDocument', {
        source: `${buildSetCssExpression(styleId, css, mode)};`,
      });
      if (res && typeof res.identifier === 'string') identifier = res.identifier;
    } catch (err) {
      return {
        ok: false,
        error: { code: 'OVERTY_CDP_ERROR', message: 'Failed to install CSS persistently', details: String(err && err.message ? err.message : err) },
      };
    }

    this._installedCss.set(styleId, { identifier, mode, length: css.length });

    // Apply immediately to the current document too.
    const applyRes = await this.evaluate(buildSetCssExpression(styleId, css, mode), {
      returnByValue: true,
      awaitPromise: true,
      timeoutMs: 30_000,
    });
    if (!applyRes.ok) return applyRes;

    return {
      ok: true,
      styleId,
      identifier,
      mode,
      length: css.length,
      applied: true,
      result: getRemoteObjectValue(applyRes.result),
    };
  }

  async uninstallCss(opts) {
    const removeFromPage = !(opts && Object.prototype.hasOwnProperty.call(opts, 'removeFromPage')) || !!opts.removeFromPage;
    const styleId = opts && typeof opts.styleId === 'string' && opts.styleId.trim() ? opts.styleId.trim() : null;

    const targets = styleId ? [styleId] : Array.from(this._installedCss.keys());
    const removed = [];
    const notInstalled = [];

    for (const id of targets) {
      const meta = this._installedCss.get(id) || null;
      if (!meta) {
        notInstalled.push(id);
        continue;
      }
      if (meta.identifier) {
        try {
          await this._send('Page.removeScriptToEvaluateOnNewDocument', { identifier: meta.identifier });
        } catch {
          // Best-effort; continue.
        }
      }
      this._installedCss.delete(id);

      let removedFromPage = null;
      if (removeFromPage) {
        const rmRes = await this.evaluate(buildRemoveStyleExpression(id), {
          returnByValue: true,
          awaitPromise: true,
          timeoutMs: 30_000,
        });
        removedFromPage = rmRes.ok ? getRemoteObjectValue(rmRes.result) : null;
      }

      removed.push({ styleId: id, identifier: meta.identifier || null, removedFromPage });
    }

    return { ok: true, removed, notInstalled };
  }

  async enableNetwork() {
    if (this._networkEnabled) return { ok: true };
    try {
      await this._send('Network.enable');
      this._networkEnabled = true;
      this._networkInFlight.clear();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: { code: 'OVERTY_CDP_ERROR', message: 'Failed to enable Network domain', details: String(err && err.message ? err.message : err) },
      };
    }
  }

  async waitForNetworkIdle(opts) {
    const timeoutMs = Number.isFinite(opts && opts.timeoutMs) ? Math.max(0, Math.floor(opts.timeoutMs)) : 30_000;
    const idleMs = Number.isFinite(opts && opts.idleMs) ? Math.max(0, Math.floor(opts.idleMs)) : 500;
    const pollMs = Number.isFinite(opts && opts.pollMs) ? Math.max(10, Math.floor(opts.pollMs)) : 100;
    const maxInflight = Number.isFinite(opts && opts.maxInflight) ? Math.max(0, Math.floor(opts.maxInflight)) : 0;

    const ignoreResourceTypesRaw =
      opts && Array.isArray(opts.ignoreResourceTypes) ? opts.ignoreResourceTypes.map((s) => String(s)) : ['EventSource', 'WebSocket'];
    const ignoreResourceTypes = new Set(ignoreResourceTypesRaw);

    const enableRes = await this.enableNetwork();
    if (!enableRes.ok) return enableRes;

    const start = Date.now();
    let idleStart = null;

    while (true) {
      const now = Date.now();
      if (timeoutMs > 0 && now - start > timeoutMs) {
        const sample = [];
        for (const [requestId, info] of this._networkInFlight.entries()) {
          const type = info && info.type ? String(info.type) : 'Other';
          if (ignoreResourceTypes.has(type)) continue;
          sample.push({
            requestId,
            type,
            url: info && typeof info.url === 'string' ? info.url : null,
            ageMs: Number.isFinite(info && info.tsStart) ? now - info.tsStart : null,
          });
          if (sample.length >= 10) break;
        }
        return {
          ok: false,
          error: {
            code: 'OVERTY_TIMEOUT',
            message: 'Timed out waiting for network idle',
            details: { timeoutMs, idleMs, pollMs, maxInflight, ignoreResourceTypes: Array.from(ignoreResourceTypes), sampleInFlight: sample },
          },
        };
      }

      const total = this._networkInFlight.size;
      let relevant = 0;
      for (const [, info] of this._networkInFlight.entries()) {
        const type = info && info.type ? String(info.type) : 'Other';
        if (ignoreResourceTypes.has(type)) continue;
        relevant += 1;
      }

      if (relevant <= maxInflight) {
        if (idleStart === null) idleStart = now;
        if (now - idleStart >= idleMs) {
          return {
            ok: true,
            timeoutMs,
            idleMs,
            pollMs,
            maxInflight,
            ignoreResourceTypes: Array.from(ignoreResourceTypes),
            totalInflight: total,
            inflight: relevant,
            ignoredInflight: total - relevant,
          };
        }
      } else {
        idleStart = null;
      }

      await sleep(pollMs);
    }
  }

  async _listTargets(browserUrl) {
    const base = browserUrl.toString().replace(/\/$/, '');
    const endpoints = [`${base}/json/list`, `${base}/json`];

    let lastErr = null;
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} from ${url}`);
          continue;
        }
        const json = await res.json();
        if (!Array.isArray(json)) {
          lastErr = new Error(`Unexpected JSON from ${url} (expected array)`);
          continue;
        }
        const targets = json
          .filter((t) => t && typeof t.webSocketDebuggerUrl === 'string')
          .map((t) => ({
            id: t.id,
            type: t.type,
            title: t.title,
            url: t.url,
            webSocketDebuggerUrl: t.webSocketDebuggerUrl,
          }));
        return { ok: true, targets };
      } catch (err) {
        lastErr = err;
      }
    }
    return {
      ok: false,
      error: { code: 'OVERTY_CDP_UNREACHABLE', message: `Could not list targets from ${base}`, details: String(lastErr) },
    };
  }

  async _connectWebSocket(wsUrl) {
    const url = String(wsUrl || '').trim();
    if (!url) throw new Error('Missing webSocketDebuggerUrl');

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      try {
        // Prefer ArrayBuffer for binary frames if any.
        ws.binaryType = 'arraybuffer';
      } catch {
        // ignore
      }
      const onOpen = () => {
        cleanup();
        debugLog('ws open', url);
        resolve();
      };
      const onError = (event) => {
        cleanup();
        // undici WebSocket gives Event, not Error.
        debugLog('ws error', url);
        reject(new Error(`WebSocket error connecting to ${url}`));
      };
      const onClose = () => {
        // If close happens before open, treat as failure.
        cleanup();
        debugLog('ws close before open', url);
        reject(new Error(`WebSocket closed before open: ${url}`));
      };

      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);

      this._ws = ws;
      // Guard against late events from an old socket after reconnect.
      const socket = ws;
      this._ws.addEventListener('message', (event) => this._onWsMessage(event, socket));
      this._ws.addEventListener('close', () => this._onWsClose(socket));
    });
  }

  _onWsClose(socket) {
    if (socket && this._ws && socket !== this._ws) return;
    for (const [, p] of this._pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('CDP connection closed'));
    }
    this._pending.clear();
    this._installedCss.clear();
    this._networkEnabled = false;
    this._networkInFlight.clear();
    this._ws = null;
    this._selectedTarget = null;
  }

  _onWsMessage(event, socket) {
    if (socket && this._ws && socket !== this._ws) return;
    let text = '';
    let buf = null;
    try {
      // MessageEvent.data is typically defined via prototype getter, not an own property.
      const raw = event && typeof event === 'object' && 'data' in event ? event.data : null;
      if (typeof raw === 'string') {
        buf = Buffer.from(raw, 'utf8');
        text = raw;
      } else if (raw instanceof ArrayBuffer) {
        buf = Buffer.from(raw);
        text = buf.toString('utf8');
      } else if (ArrayBuffer.isView(raw)) {
        buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        text = buf.toString('utf8');
      } else {
        buf = Buffer.from(raw || []);
        text = buf.toString('utf8');
      }
    } catch (err) {
      debugLog('ws message decode failed', String(err && err.message ? err.message : err));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      const meta = buf
        ? { bytes: buf.length, hex: buf.slice(0, 24).toString('hex'), textPreview: JSON.stringify(text.slice(0, 200)) }
        : { bytes: null, hex: null, textPreview: JSON.stringify(text.slice(0, 200)) };
      debugLog('ws non-json message', meta);
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    // Response to a command we sent.
    if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
      const id =
        typeof msg.id === 'number'
          ? msg.id
          : typeof msg.id === 'string' && msg.id.trim() && Number.isFinite(Number(msg.id))
            ? Number(msg.id)
            : null;
      if (id === null) return;
      debugLog('cdp recv response', { id, hasError: !!msg.error });
      const pending = this._pending.get(id);
      if (!pending) return;
      this._pending.delete(id);
      clearTimeout(pending.timeout);

      if (msg.error) {
        pending.reject(new Error(msg.error.message || 'CDP error'));
        return;
      }
      pending.resolve(msg.result);
      return;
    }

    // CDP event.
    if (typeof msg.method === 'string') {
      debugLog('cdp recv event', msg.method);
      this._onCdpEvent(msg.method, msg.params);
    }
  }

  _send(method, params, options = {}) {
    if (!this.isConnected) {
      return Promise.reject(new Error('Not connected to CDP'));
    }

    const id = this._nextId++;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000;

    const payload = { id, method, ...(params ? { params } : {}) };
    const json = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP timeout waiting for ${method}`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timeout });

      try {
        debugLog('cdp send', { id, method });
        this._ws.send(json);
      } catch (err) {
        clearTimeout(timeout);
        this._pending.delete(id);
        reject(err);
      }
    });
  }
}

function selectTarget(targets, opts) {
  const wantedId = opts.targetId ? String(opts.targetId) : null;
  const wantedIndex =
    Number.isFinite(opts.targetIndex) && opts.targetIndex >= 0 ? Math.floor(opts.targetIndex) : null;
  const urlSub = opts.targetUrlSubstring ? String(opts.targetUrlSubstring) : null;
  const titleSub = opts.targetTitleSubstring ? String(opts.targetTitleSubstring) : null;

  const pool = targets.filter((t) => t && typeof t.webSocketDebuggerUrl === 'string');
  if (pool.length === 0) return null;

  if (wantedId) {
    const match = pool.find((t) => String(t.id || '') === wantedId);
    if (match) return match;
  }

  if (urlSub || titleSub) {
    const match = pool.find((t) => {
      if (urlSub && typeof t.url === 'string' && t.url.includes(urlSub)) return true;
      if (titleSub && typeof t.title === 'string' && t.title.includes(titleSub)) return true;
      return false;
    });
    if (match) return match;
  }

  if (wantedIndex !== null) return pool[wantedIndex] || null;

  // Prefer "page" targets if present.
  const page = pool.find((t) => t.type === 'page');
  return page || pool[0];
}

const TOOL_DEFS = [
  {
    name: 'connect',
    title: 'Connect To CDP',
    description:
      'Connect to a Chrome DevTools Protocol (CDP) endpoint, list available targets, and select one for subsequent tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        browserUrl: {
          type: 'string',
          description: `CDP HTTP endpoint (default: ${DEFAULT_BROWSER_URL}). Examples: http://127.0.0.1:9222, localhost:9222`,
        },
        allowRemote: {
          type: 'boolean',
          description: 'If true, allow non-loopback CDP endpoints. Default false (loopback-only).',
        },
        targetIndex: {
          type: 'integer',
          minimum: 0,
          description: 'Select target by index in the returned targets list (0-based).',
        },
        targetId: {
          type: 'string',
          description: 'Select target by exact target id (from /json/list).',
        },
        targetUrlSubstring: {
          type: 'string',
          description: 'Select the first target whose URL contains this substring.',
        },
        targetTitleSubstring: {
          type: 'string',
          description: 'Select the first target whose title contains this substring.',
        },
        navigateUrl: {
          type: 'string',
          description: 'Optional: after connecting, navigate the selected target to this URL.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_targets',
    title: 'List CDP Targets',
    description: 'List debuggable targets from a CDP HTTP endpoint (without connecting).',
    inputSchema: {
      type: 'object',
      properties: {
        browserUrl: {
          type: 'string',
          description: `CDP HTTP endpoint (default: ${DEFAULT_BROWSER_URL}).`,
        },
        allowRemote: {
          type: 'boolean',
          description: 'If true, allow non-loopback CDP endpoints. Default false (loopback-only).',
        },
      },
      required: [],
    },
  },
  {
    name: 'open_page',
    title: 'Open New Page',
    description:
      'Open a new page via the CDP HTTP endpoint (/json/new). Optionally connect to it so subsequent tool calls operate on that page.',
    inputSchema: {
      type: 'object',
      properties: {
        browserUrl: {
          type: 'string',
          description: `CDP HTTP endpoint (default: ${DEFAULT_BROWSER_URL}).`,
        },
        allowRemote: {
          type: 'boolean',
          description: 'If true, allow non-loopback CDP endpoints. Default false (loopback-only).',
        },
        url: {
          type: 'string',
          description: 'URL to open in the new page (default: about:blank).',
        },
        connect: {
          type: 'boolean',
          description: 'If true, connect to the new page immediately. Default true.',
        },
        activate: {
          type: 'boolean',
          description: 'If true, bring the new page to the front (best-effort). Default true.',
        },
      },
      required: [],
    },
  },
  {
    name: 'close_target',
    title: 'Close Target',
    description: 'Close a target/page by targetId via the CDP HTTP endpoint (/json/close/{id}).',
    inputSchema: {
      type: 'object',
      properties: {
        browserUrl: {
          type: 'string',
          description: `CDP HTTP endpoint (default: ${DEFAULT_BROWSER_URL}).`,
        },
        allowRemote: {
          type: 'boolean',
          description: 'If true, allow non-loopback CDP endpoints. Default false (loopback-only).',
        },
        targetId: {
          type: 'string',
          description: 'Target id to close. If omitted, closes the currently connected target (if any).',
        },
      },
      required: [],
    },
  },
  {
    name: 'set_viewport',
    title: 'Set Viewport',
    description:
      'Set a viewport size for consistent screenshots using Emulation.setDeviceMetricsOverride.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1, description: 'Viewport width in CSS pixels.' },
        height: { type: 'integer', minimum: 1, description: 'Viewport height in CSS pixels.' },
        deviceScaleFactor: {
          type: 'number',
          minimum: 0,
          description: 'Device scale factor (default: 1).',
        },
        mobile: {
          type: 'boolean',
          description: 'Whether to emulate a mobile device (default: false).',
        },
      },
      required: ['width', 'height'],
    },
  },
  {
    name: 'clear_viewport',
    title: 'Clear Viewport Override',
    description: 'Clear any viewport/device metrics override previously set by set_viewport.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_css',
    title: 'Set CSS',
    description:
      `Create/update a <style> tag in the page and set its CSS text. Default style id: "${DEFAULT_STYLE_ID}".`,
    inputSchema: {
      type: 'object',
      properties: {
        css: { type: 'string', description: 'CSS text to apply.' },
        styleId: { type: 'string', description: `Style element id (default: ${DEFAULT_STYLE_ID}).` },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'Whether to replace or append to the existing style text. Default replace.',
        },
      },
      required: ['css'],
    },
  },
  {
    name: 'install_css',
    title: 'Install CSS (Persistent)',
    description:
      'Install a persistent CSS injection for the current target (Page.addScriptToEvaluateOnNewDocument) and apply it immediately. Useful for keeping a live CSS patch across navigations/reloads.',
    inputSchema: {
      type: 'object',
      properties: {
        css: { type: 'string', description: 'CSS text to install.' },
        styleId: { type: 'string', description: `Style element id (default: ${DEFAULT_STYLE_ID}).` },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'Replace or append CSS text (default: replace).' },
      },
      required: ['css'],
    },
  },
  {
    name: 'uninstall_css',
    title: 'Uninstall CSS (Persistent)',
    description:
      'Remove a previously installed persistent CSS injection (Page.removeScriptToEvaluateOnNewDocument). By default also removes the <style> element from the current document.',
    inputSchema: {
      type: 'object',
      properties: {
        styleId: {
          type: 'string',
          description: `Style element id to uninstall. If omitted, uninstalls all installs created by install_css (default: all).`,
        },
        removeFromPage: {
          type: 'boolean',
          description: `If true, remove the <style> element from the current document as well (default: true).`,
        },
      },
      required: [],
    },
  },
  {
    name: 'list_installed_css',
    title: 'List Installed CSS',
    description: 'List persistent CSS installs previously created by install_css in this session.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wait_for',
    title: 'Wait For',
    description:
      'Wait for a delay, a DOM text snippet to appear, or a JS predicate expression to become truthy.',
    inputSchema: {
      type: 'object',
      properties: {
        timeMs: { type: 'integer', minimum: 0, description: 'Sleep for this many milliseconds.' },
        text: {
          type: 'string',
          description: 'Wait until document.body innerText contains this substring.',
        },
        expression: {
          type: 'string',
          description: 'JS expression/predicate evaluated repeatedly until it returns a truthy value.',
        },
        timeoutMs: { type: 'integer', minimum: 0, description: 'Overall timeout in ms (default: 30000).' },
        pollMs: { type: 'integer', minimum: 10, description: 'Polling interval in ms (default: 100).' },
      },
      required: [],
    },
  },
  {
    name: 'wait_for_network_idle',
    title: 'Wait For Network Idle',
    description:
      'Wait until the Network domain has <= maxInflight in-flight requests for at least idleMs. Enables Network domain lazily. By default ignores EventSource and WebSocket so long-lived connections do not block.',
    inputSchema: {
      type: 'object',
      properties: {
        idleMs: { type: 'integer', minimum: 0, description: 'Required quiet window in ms (default: 500).' },
        timeoutMs: { type: 'integer', minimum: 0, description: 'Overall timeout in ms (default: 30000).' },
        pollMs: { type: 'integer', minimum: 10, description: 'Polling interval in ms (default: 100).' },
        maxInflight: { type: 'integer', minimum: 0, description: 'Treat as idle when in-flight <= this number (default: 0).' },
        ignoreResourceTypes: {
          type: 'array',
          description: 'Optional list of Network.ResourceType values to ignore (default: ["EventSource","WebSocket"]).',
          items: { type: 'string' },
        },
      },
      required: [],
    },
  },
  {
    name: 'navigate',
    title: 'Navigate',
    description:
      'Navigate the currently selected target to a URL, then optionally wait for document readiness and/or app-specific signals.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to.' },
        waitUntil: {
          type: 'string',
          enum: ['none', 'domcontentloaded', 'load'],
          description: 'Document readiness to wait for (default: load).',
        },
        waitForText: { type: 'string', description: 'Optional: wait until document.body innerText contains this substring.' },
        waitForExpression: { type: 'string', description: 'Optional: JS predicate expression to wait for after navigation.' },
        timeoutMs: { type: 'integer', minimum: 0, description: 'Overall timeout in ms (default: 30000).' },
        pollMs: { type: 'integer', minimum: 10, description: 'Polling interval in ms (default: 100).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_events',
    title: 'List Captured Events',
    description:
      'List captured CDP events (console, exceptions, logs) since connect(). Useful for debugging layout/CSS/JS issues while iterating.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceSeq: { type: 'integer', minimum: 0, description: 'Only return events with seq > sinceSeq.' },
        limit: { type: 'integer', minimum: 1, description: 'Max events to return (default: 50).' },
        types: {
          type: 'array',
          description: 'Optional filter: any of ["console","exception","log"].',
          items: { type: 'string', enum: ['console', 'exception', 'log'] },
        },
        clear: { type: 'boolean', description: 'If true, clear buffered events after returning.' },
      },
      required: [],
    },
  },
  {
    name: 'audit_layout',
    title: 'Audit Layout',
    description:
      'Heuristic layout audit: detect horizontal overflow and report a few elements that extend past the viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        tolerancePx: { type: 'integer', minimum: 0, description: 'Tolerance in px for overflow detection (default: 1).' },
        maxElements: { type: 'integer', minimum: 1, description: 'Max overflowing elements to return (default: 30).' },
      },
      required: [],
    },
  },
  {
    name: 'capture_bundle',
    title: 'Capture Bundle',
    description:
      'Capture a screenshot + DOM snapshot + recent console/log/exception events + a layout audit into an output folder for quick visual QA and bug reports.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Optional label used in the default output folder name.' },
        outputDir: { type: 'string', description: `Optional output directory (default: ${path.relative(process.cwd(), DEFAULT_BUNDLE_DIR)}/<timestamp>-<label>/).` },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Screenshot format (default: png).' },
        quality: { type: 'integer', minimum: 0, maximum: 100, description: 'Quality for jpeg/webp.' },
        fullPage: { type: 'boolean', description: 'If true, attempt a full-page screenshot (best-effort). Default false.' },
        inlineScreenshot: { type: 'boolean', description: 'If true, attach the screenshot inline when small enough. Default false.' },

        includeDom: { type: 'boolean', description: 'If true, include a DOM snapshot file (default true).' },
        domSelector: { type: 'string', description: 'Optional selector for DOM snapshot (defaults to documentElement).' },
        domMaxChars: { type: 'integer', minimum: 1, description: 'Max chars for DOM snapshot (default: 200000).' },

        includeEvents: { type: 'boolean', description: 'If true, include an events.json file (default true).' },
        eventsSinceSeq: { type: 'integer', minimum: 0, description: 'Only include events with seq > eventsSinceSeq.' },
        eventsLimit: { type: 'integer', minimum: 1, description: 'Max events to include (default: 200).' },
        eventsTypes: {
          type: 'array',
          description: 'Optional filter: any of ["console","exception","log"].',
          items: { type: 'string', enum: ['console', 'exception', 'log'] },
        },
        clearEvents: { type: 'boolean', description: 'If true, clear buffered events after capture (default false).' },

        includeLayoutAudit: { type: 'boolean', description: 'If true, include a layout.json file (default true).' },
        tolerancePx: { type: 'integer', minimum: 0, description: 'Tolerance in px for overflow detection (default: 1).' },
        maxElements: { type: 'integer', minimum: 1, description: 'Max overflowing elements to include (default: 30).' },
      },
      required: [],
    },
  },
  {
    name: 'assert_layout',
    title: 'Assert Layout Rules',
    description:
      'Run layout assertions (overflow, clipped text, overlaps, tap target size) and return pass/fail with sampled violations.',
    inputSchema: {
      type: 'object',
      properties: {
        rules: {
          type: 'object',
          description: 'Optional layout rule object. Top-level rule fields are also accepted for convenience.',
        },
        overflowTolerancePx: { type: 'integer', minimum: 0, description: 'Tolerance for overflow/offender detection (default: 1).' },
        maxHorizontalOverflowPx: { type: 'integer', minimum: 0, description: 'Maximum allowed horizontal overflow in px (default: 0).' },
        maxOverflowingElements: { type: 'integer', minimum: 0, description: 'Maximum allowed overflowing elements (default: 0).' },
        maxClippedText: { type: 'integer', minimum: 0, description: 'Maximum allowed potentially clipped text elements (default: 0).' },
        maxOverlapCount: { type: 'integer', minimum: 0, description: 'Maximum allowed overlapping element pairs (default: 0).' },
        maxTapTargetViolations: {
          type: 'integer',
          minimum: 0,
          description: 'Maximum allowed interactive targets under minTapTargetPx (default: 0).',
        },
        minTapTargetPx: { type: 'number', minimum: 1, description: 'Minimum interactive target size in px (default: 44).' },
        overlapTolerancePx: { type: 'number', minimum: 0, description: 'Minimum overlap intersection size to count in px (default: 2).' },
        maxElements: { type: 'integer', minimum: 1, description: 'Maximum sampled elements returned per category (default: 30).' },
        overlapCandidateLimit: {
          type: 'integer',
          minimum: 10,
          description: 'Maximum elements considered for overlap analysis before pairwise checks (default: 120).',
        },
        overlapSelector: { type: 'string', description: 'Selector scope for overlap detection (default: "body *").' },
        includeOverlaps: { type: 'boolean', description: 'Whether to run overlap analysis (default: true).' },
      },
      required: [],
    },
  },
  {
    name: 'visual_diff',
    title: 'Visual Diff',
    description:
      'Compare two screenshots and compute pixel-diff metrics. Candidate can be a file or the current page screenshot. Optionally writes a PNG diff artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        baselinePath: { type: 'string', description: 'Required path to baseline image (png/jpg/webp).' },
        candidatePath: {
          type: 'string',
          description: 'Optional path to candidate image. If omitted, captures current page screenshot.',
        },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Format used when auto-capturing candidate (default: png).' },
        quality: { type: 'integer', minimum: 0, maximum: 100, description: 'Quality used for jpeg/webp candidate capture.' },
        fullPage: { type: 'boolean', description: 'If true, candidate capture is full-page (default: false).' },
        threshold: {
          type: 'number',
          minimum: 0,
          maximum: 255,
          description: 'Per-channel delta threshold used to count a pixel as different (default: 16).',
        },
        failPercent: { type: 'number', minimum: 0, maximum: 100, description: 'Optional max diff percent threshold for pass/fail.' },
        failOnDimensionMismatch: {
          type: 'boolean',
          description: 'If true, dimension mismatch forces fail even if diffPercent is low (default: false).',
        },
        writeDiff: {
          type: 'boolean',
          description: `If true, write diff PNG. Default true when diffPath is provided, otherwise false.`,
        },
        diffPath: {
          type: 'string',
          description: `Optional path for diff PNG output (default: ${path.relative(process.cwd(), DEFAULT_DIFF_DIR)}/diff-<timestamp>.png when writeDiff=true).`,
        },
        inlineDiff: { type: 'boolean', description: 'If true, attach diff image inline when small enough (default: false).' },
      },
      required: ['baselinePath'],
    },
  },
  {
    name: 'qa_matrix',
    title: 'QA Matrix (Viewport Sweep)',
    description:
      'Capture screenshots (and optional layout assertions) across a viewport matrix and write a manifest with per-viewport results.',
    inputSchema: {
      type: 'object',
      properties: {
        outputDir: {
          type: 'string',
          description: `Directory to write matrix artifacts (default: ${path.relative(process.cwd(), DEFAULT_MATRIX_DIR)}/<timestamp>/).`,
        },
        viewports: {
          type: 'array',
          description: 'Viewport definitions. Default: mobile/tablet/desktop.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              width: { type: 'integer', minimum: 1 },
              height: { type: 'integer', minimum: 1 },
              deviceScaleFactor: { type: 'number', minimum: 0 },
              mobile: { type: 'boolean' },
              fullPage: { type: 'boolean', description: 'Override fullPage screenshot for this viewport.' },
              waitMs: { type: 'integer', minimum: 0, description: 'Optional wait after viewport is set.' },
            },
            required: ['name', 'width', 'height'],
          },
        },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Screenshot format (default: png).' },
        quality: { type: 'integer', minimum: 0, maximum: 100, description: 'Quality for jpeg/webp screenshots.' },
        fullPage: { type: 'boolean', description: 'Default fullPage flag for matrix captures (default: false).' },
        waitMs: { type: 'integer', minimum: 0, description: 'Default wait after viewport set and before capture (default: 120).' },
        includeLayoutAudit: { type: 'boolean', description: 'If true, include audit_layout result per viewport (default: true).' },
        includeAssertions: {
          type: 'boolean',
          description: 'If true, run assert_layout per viewport and include pass/fail (default: true).',
        },
        assertRules: { type: 'object', description: 'Optional rules passed to assert_layout.' },
        includeEvents: { type: 'boolean', description: 'If true, include event summary per viewport (default: true).' },
        eventsLimit: { type: 'integer', minimum: 1, description: 'Max events considered per viewport (default: 150).' },
        writeManifest: { type: 'boolean', description: 'If true, write `manifest.json` (default: true).' },
        clearViewportAtEnd: { type: 'boolean', description: 'If true, clear viewport override after matrix run (default: true).' },
        inlineLimit: { type: 'integer', minimum: 0, description: 'Attach up to this many screenshots inline when small enough (default: 0).' },
      },
      required: [],
    },
  },
  {
    name: 'render_html_mockups',
    title: 'Render HTML Mockups (Batch)',
    description:
      'Render a standalone HTML string in a fresh tab, apply multiple CSS variants, and save screenshots for each variant. Optionally restores the previously connected target.',
    inputSchema: {
      type: 'object',
      properties: {
        browserUrl: {
          type: 'string',
          description: `CDP HTTP endpoint (default: ${DEFAULT_BROWSER_URL}). If omitted and already connected, uses the current connection's browserUrl.`,
        },
        allowRemote: {
          type: 'boolean',
          description: 'If true, allow non-loopback CDP endpoints. Default false (loopback-only).',
        },
        html: { type: 'string', description: 'Standalone HTML document to render.' },
        baseCss: { type: 'string', description: 'Optional CSS applied before each variant.' },
        viewport: {
          type: 'object',
          properties: {
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
            deviceScaleFactor: { type: 'number', minimum: 0 },
            mobile: { type: 'boolean' },
          },
        },
        variants: {
          type: 'array',
          description: 'CSS variants to render and screenshot.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Variant name (used in filenames).' },
              css: { type: 'string', description: 'Variant CSS.' },
              js: { type: 'string', description: 'Optional JS to run after applying CSS.' },
              waitMs: { type: 'integer', minimum: 0, description: 'Optional delay before screenshot.' },
              fullPage: { type: 'boolean', description: 'If true, attempt a full-page screenshot.' },
            },
            required: ['name'],
          },
        },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Screenshot format (default: png).' },
        quality: { type: 'integer', minimum: 0, maximum: 100, description: 'Quality for jpeg/webp.' },
        outputDir: {
          type: 'string',
          description: `Directory to save screenshots (default: ${path.relative(process.cwd(), DEFAULT_MOCKUP_DIR)}/<timestamp>/).`,
        },
        writeHtmlFiles: {
          type: 'boolean',
          description: 'If true, write a standalone .html file per variant alongside screenshots. Default true.',
        },
        writeManifest: {
          type: 'boolean',
          description: 'If true, write manifest.json in outputDir describing all variants. Default true.',
        },
        writeIndexHtml: {
          type: 'boolean',
          description: 'If true, write index.html gallery in outputDir for quick review. Default true.',
        },
        indexTitle: { type: 'string', description: 'Optional title for the generated index.html.' },
        includeEventSummary: {
          type: 'boolean',
          description: 'If true, include per-variant console/log/exception summary (best-effort). Default true.',
        },
        keepPageOpen: { type: 'boolean', description: 'If true, do not close the mockup tab. Default false.' },
        restorePreviousTarget: {
          type: 'boolean',
          description: 'If true and previously connected, reconnect to the previous target after rendering. Default true.',
        },
        inlineLimit: {
          type: 'integer',
          minimum: 0,
          description:
            'If > 0, attach up to this many successful variant screenshots inline (best-effort; large images are skipped). Default 0 (no inline images).',
        },
      },
      required: ['html', 'variants'],
    },
  },
  {
    name: 'execute_js',
    title: 'Execute JavaScript',
    description:
      'Execute JavaScript in the currently selected target (CDP Runtime.evaluate). Useful for injecting CSS into a live UI and iterating via screenshots.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate in the page context.',
        },
        awaitPromise: {
          type: 'boolean',
          description: 'If true, await returned promise. Default true.',
        },
        returnByValue: {
          type: 'boolean',
          description: 'If true, return JSON-serializable value. Default true.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 0,
          description: 'Timeout in milliseconds for CDP response. Default 30000.',
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'take_screenshot',
    title: 'Take Screenshot',
    description: 'Capture a screenshot of the currently selected target.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: 'Image format (default: png).',
        },
        quality: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Image quality (0-100). Only applies to jpeg/webp.',
        },
        fullPage: {
          type: 'boolean',
          description: 'If true, attempt a full-page capture (best-effort). Default false.',
        },
        filePath: {
          type: 'string',
          description:
            'Optional: save the screenshot to this path (absolute or relative). If omitted, image is returned inline when small enough.',
        },
      },
      required: [],
    },
  },
  {
    name: 'screenshot_element',
    title: 'Screenshot Element',
    description:
      'Capture a screenshot of a single element matched by CSS selector (best-effort clip to the viewport).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to target.' },
        index: { type: 'integer', minimum: 0, description: 'Which match to use (0-based). Default 0.' },
        paddingPx: { type: 'number', minimum: 0, description: 'Extra padding around the element clip in px (default: 0).' },
        scrollIntoView: { type: 'boolean', description: 'If true, scroll element into view before capture. Default true.' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default: png).' },
        quality: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Image quality (0-100). Only applies to jpeg/webp.',
        },
        filePath: {
          type: 'string',
          description:
            'Optional: save the screenshot to this path (absolute or relative). If omitted, image is returned inline when small enough.',
        },
        timeoutMs: { type: 'integer', minimum: 0, description: 'Timeout for selector lookup + capture (default: 30000).' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'take_dom_snapshot',
    title: 'Take DOM Snapshot',
    description:
      'Return the current DOM as HTML (document.documentElement.outerHTML) or a selected element outerHTML.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Optional: CSS selector. If provided, snapshot is outerHTML of the first match.',
        },
        maxChars: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum characters to return (default: 200000).',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 0,
          description: 'Timeout in milliseconds for the underlying JS evaluation. Default 30000.',
        },
      },
      required: [],
    },
  },
];

const cdp = new CdpSession();

async function handleRequest(msg) {
  switch (msg.method) {
    case 'initialize': {
      const clientProto = msg.params && msg.params.protocolVersion ? String(msg.params.protocolVersion) : MCP_PROTOCOL_VERSION;
      return {
        protocolVersion: clientProto || MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
        instructions: [
          'overty connects to a CDP endpoint (Chrome/Electron) and lets you:',
          '- execute JS (inject CSS, query layout, read state)',
          '- set CSS quickly (set_css)',
          '- install CSS persistently across reloads (install_css / uninstall_css / list_installed_css)',
          '- set a consistent viewport (set_viewport)',
          '- navigate with readiness waits (navigate)',
          '- wait for stability (wait_for)',
          '- wait for network idle (wait_for_network_idle)',
          '- inspect console/log/exception events (list_events)',
          '- run a basic layout audit (audit_layout)',
          '- assert layout quality rules (assert_layout)',
          '- compare screenshots with pixel-diff metrics (visual_diff)',
          '- run viewport QA sweeps with screenshots + assertions (qa_matrix)',
          '- capture a QA bundle (capture_bundle)',
          '- take screenshots for instant visual QA',
          '- screenshot a single element (screenshot_element)',
          '- snapshot DOM (outerHTML) for inspection',
          '- batch-render standalone HTML mockups with CSS variants + gallery (render_html_mockups)',
          '',
          `Default CDP endpoint: ${DEFAULT_BROWSER_URL}`,
          'Safety: connect() refuses non-loopback endpoints unless allowRemote=true.',
        ].join('\n'),
      };
    }

    case 'ping': {
      return {};
    }

    case 'tools/list': {
      return { tools: TOOL_DEFS };
    }

    case 'tools/call': {
      const name = msg.params && msg.params.name ? String(msg.params.name) : '';
      const args = (msg.params && msg.params.arguments) || {};

      switch (name) {
        case 'connect': {
          const res = await cdp.connect({
            browserUrl: args.browserUrl,
            allowRemote: !!args.allowRemote,
            targetIndex: args.targetIndex,
            targetId: args.targetId,
            targetUrlSubstring: args.targetUrlSubstring,
            targetTitleSubstring: args.targetTitleSubstring,
            navigateUrl: args.navigateUrl,
          });
          if (!res.ok) return toolError(res.error.code, res.error.message, res.error.details);

          return {
            content: [
              {
                type: 'text',
                text: [
                  `Connected to ${res.browserUrl}`,
                  `Selected: [${res.selectedTarget.type}] ${res.selectedTarget.title || '(untitled)'} ${res.selectedTarget.url || ''}`.trim(),
                  `Targets: ${res.targets.length}`,
                ].join('\n'),
              },
            ],
            structuredContent: { browserUrl: res.browserUrl, selectedTarget: res.selectedTarget, targets: res.targets },
          };
        }

        case 'list_targets': {
          const rawBrowserUrl = args.browserUrl || cdp.browserUrl || DEFAULT_BROWSER_URL;
          const guard = requireLoopbackUnlessAllowed(rawBrowserUrl, !!args.allowRemote);
          if (!guard.ok) return toolError(guard.error.code, guard.error.message, guard.error.details);

          const targetsRes = await cdp._listTargets(guard.url);
          if (!targetsRes.ok) return toolError(targetsRes.error.code, targetsRes.error.message, targetsRes.error.details);

          const base = toCdpHttpBase(guard.url.toString());
          return {
            content: [{ type: 'text', text: `Targets: ${targetsRes.targets.length}\nBrowser: ${base}` }],
            structuredContent: { browserUrl: base, targets: targetsRes.targets },
          };
        }

        case 'open_page': {
          const rawBrowserUrl = args.browserUrl || cdp.browserUrl || DEFAULT_BROWSER_URL;
          const allowRemote = !!args.allowRemote;
          const url = args.url ? String(args.url) : 'about:blank';
          const doConnect = args.connect !== false;
          const doActivate = args.activate !== false;

          const newPage = await cdpHttpNewPage({ browserUrl: rawBrowserUrl, allowRemote, url });
          if (!newPage.ok) return toolError(newPage.error.code, newPage.error.message, newPage.error.details);

          const target = newPage.target;

          if (doActivate) {
            const actRes = await cdpHttpActivate({ browserUrl: rawBrowserUrl, allowRemote, targetId: target.id });
            // Best-effort focus; don't fail open_page if activation fails.
            if (!actRes.ok) log('open_page: activate failed', actRes.error);
          }

          if (!doConnect) {
            return {
              content: [{ type: 'text', text: `Opened new page (not connected): ${target.id} ${target.url || ''}`.trim() }],
              structuredContent: { browserUrl: toCdpHttpBase(rawBrowserUrl), target },
            };
          }

          const conn = await cdp.connect({ browserUrl: rawBrowserUrl, allowRemote, targetId: target.id });
          if (!conn.ok) return toolError(conn.error.code, conn.error.message, conn.error.details);

          return {
            content: [{ type: 'text', text: `Opened + connected: ${conn.browserUrl}\nTarget: ${conn.selectedTarget.id} ${conn.selectedTarget.url || ''}`.trim() }],
            structuredContent: { browserUrl: conn.browserUrl, selectedTarget: conn.selectedTarget, targets: conn.targets },
          };
        }

        case 'close_target': {
          const rawBrowserUrl = args.browserUrl || cdp.browserUrl || DEFAULT_BROWSER_URL;
          const allowRemote = !!args.allowRemote;
          const targetId = args.targetId
            ? String(args.targetId)
            : cdp.selectedTarget && cdp.selectedTarget.id
              ? String(cdp.selectedTarget.id)
              : '';

          if (!targetId) return toolError('OVERTY_INVALID_ARG', 'No targetId provided and no target is currently connected.');

          const closeRes = await cdpHttpClose({ browserUrl: rawBrowserUrl, allowRemote, targetId });
          if (!closeRes.ok) return toolError(closeRes.error.code, closeRes.error.message, closeRes.error.details);

          if (cdp.selectedTarget && String(cdp.selectedTarget.id) === targetId) {
            await cdp.disconnect();
          }

          return {
            content: [{ type: 'text', text: `Closed target ${targetId}` }],
            structuredContent: { targetId, result: closeRes.result },
          };
        }

        case 'set_viewport': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');
          const res = await cdp.setViewport({
            width: args.width,
            height: args.height,
            deviceScaleFactor: args.deviceScaleFactor,
            mobile: args.mobile,
          });
          if (!res.ok) return toolError(res.error.code, res.error.message, res.error.details);
          return {
            content: [{ type: 'text', text: `Viewport set: ${res.width}x${res.height} dpr=${res.deviceScaleFactor} mobile=${res.mobile}` }],
            structuredContent: res,
          };
        }

        case 'clear_viewport': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');
          const res = await cdp.clearViewport();
          return { content: [{ type: 'text', text: 'Viewport override cleared.' }], structuredContent: res };
        }

        case 'set_css': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');
          if (typeof args.css !== 'string') return toolError('OVERTY_INVALID_ARG', 'Missing required string argument: css');

          const expr = buildSetCssExpression(args.styleId, args.css, args.mode);
          const evalRes = await cdp.evaluate(expr, { returnByValue: true, awaitPromise: true, timeoutMs: 30_000 });
          if (!evalRes.ok) return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);

          const ro = evalRes.result || {};
          const value = getRemoteObjectValue(ro);
          return {
            content: [{ type: 'text', text: 'CSS applied.' }],
            structuredContent: { result: value, remoteObject: ro },
          };
        }

        case 'install_css': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');
          if (typeof args.css !== 'string') return toolError('OVERTY_INVALID_ARG', 'Missing required string argument: css');

          const res = await cdp.installCss({ css: args.css, styleId: args.styleId, mode: args.mode });
          if (!res.ok) return toolError(res.error.code, res.error.message, res.error.details);

          return {
            content: [{ type: 'text', text: `CSS installed (persistent): ${res.styleId}` }],
            structuredContent: res,
          };
        }

        case 'uninstall_css': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const res = await cdp.uninstallCss({ styleId: args.styleId, removeFromPage: args.removeFromPage });
          if (!res.ok) return toolError(res.error.code, res.error.message, res.error.details);

          return {
            content: [{ type: 'text', text: `CSS uninstalled: removed=${res.removed.length} notInstalled=${res.notInstalled.length}` }],
            structuredContent: res,
          };
        }

        case 'list_installed_css': {
          const res = cdp.listInstalledCss();
          return {
            content: [{ type: 'text', text: `Installed CSS entries: ${res.installs.length}` }],
            structuredContent: res,
          };
        }

        case 'wait_for': {
          const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(0, Math.floor(args.timeoutMs)) : 30_000;
          const pollMs = Number.isFinite(args.pollMs) ? Math.max(10, Math.floor(args.pollMs)) : 100;

          const hasTime = args.timeMs !== undefined && args.timeMs !== null;
          const hasText = typeof args.text === 'string' && args.text.length > 0;
          const hasExpr = typeof args.expression === 'string' && args.expression.length > 0;

          if (hasTime && !hasText && !hasExpr) {
            const t = Math.max(0, Math.floor(Number(args.timeMs) || 0));
            await sleep(t);
            return {
              content: [{ type: 'text', text: `Waited ${t}ms.` }],
              structuredContent: { mode: 'time', satisfied: true, elapsedMs: t },
            };
          }

          if (!hasText && !hasExpr) {
            return toolError('OVERTY_INVALID_ARG', 'Provide one of: timeMs, text, expression');
          }

          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const mode = hasExpr ? 'expression' : 'text';
          const expr = hasExpr
            ? String(args.expression)
            : `(() => {
                 const needle = ${JSON.stringify(String(args.text))};
                 const body = document.body;
                 const hay = body && typeof body.innerText === 'string' ? body.innerText : '';
                 return hay.includes(needle);
               })()`;

          const start = Date.now();
          let lastValue = undefined;

          while (Date.now() - start <= timeoutMs) {
            const evalRes = await cdp.evaluate(expr, { returnByValue: true, awaitPromise: true, timeoutMs: Math.min(5_000, timeoutMs) });
            if (!evalRes.ok) {
              if (evalRes.error && evalRes.error.code === 'OVERTY_JS_CONTEXT_LOST') {
                await sleep(pollMs);
                continue;
              }
              return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);
            }
            const ro = evalRes.result || {};
            lastValue = getRemoteObjectValue(ro);
            if (lastValue) {
              return {
                content: [{ type: 'text', text: `wait_for satisfied (${mode}).` }],
                structuredContent: { mode, satisfied: true, elapsedMs: Date.now() - start, value: lastValue },
              };
            }
            await sleep(pollMs);
          }

          return toolError('OVERTY_TIMEOUT', 'wait_for timed out', {
            mode,
            timeoutMs,
            elapsedMs: Date.now() - start,
            lastValue,
          });
        }

        case 'wait_for_network_idle': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');
          const res = await cdp.waitForNetworkIdle({
            idleMs: args.idleMs,
            timeoutMs: args.timeoutMs,
            pollMs: args.pollMs,
            maxInflight: args.maxInflight,
            ignoreResourceTypes: args.ignoreResourceTypes,
          });
          if (!res.ok) return toolError(res.error.code, res.error.message, res.error.details);
          return {
            content: [{ type: 'text', text: `Network idle: inflight=${res.inflight}/${res.totalInflight} ignored=${res.ignoredInflight}` }],
            structuredContent: res,
          };
        }

        case 'navigate': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');
          const url = args.url;
          if (typeof url !== 'string' || !url.trim()) {
            return toolError('OVERTY_INVALID_ARG', 'Missing required string argument: url');
          }

          const waitUntilRaw = args.waitUntil ? String(args.waitUntil).toLowerCase() : 'load';
          const waitUntil = ['none', 'domcontentloaded', 'load'].includes(waitUntilRaw) ? waitUntilRaw : null;
          if (!waitUntil) {
            return toolError('OVERTY_INVALID_ARG', `Invalid waitUntil: ${waitUntilRaw}`);
          }

          const waitForText = typeof args.waitForText === 'string' && args.waitForText.length > 0 ? String(args.waitForText) : null;
          const waitForExpression =
            typeof args.waitForExpression === 'string' && args.waitForExpression.length > 0 ? String(args.waitForExpression) : null;

          const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(0, Math.floor(args.timeoutMs)) : 30_000;
          const pollMs = Number.isFinite(args.pollMs) ? Math.max(10, Math.floor(args.pollMs)) : 100;

          const start = Date.now();

          try {
            await cdp._send('Page.navigate', { url: String(url) });
          } catch (err) {
            return toolError('OVERTY_CDP_ERROR', 'Page.navigate failed', String(err && err.message ? err.message : err));
          }

          if (waitUntil !== 'none') {
            const want = waitUntil === 'domcontentloaded' ? new Set(['interactive', 'complete']) : new Set(['complete']);
            let satisfied = false;
            let lastState = null;
            while (Date.now() - start <= timeoutMs) {
              const evalRes = await cdp.evaluate('document.readyState', {
                returnByValue: true,
                awaitPromise: true,
                timeoutMs: Math.min(5_000, timeoutMs),
              });
              if (evalRes.ok) {
                const state = getRemoteObjectValue(evalRes.result);
                lastState = typeof state === 'string' ? state : lastState;
                if (typeof state === 'string' && want.has(state)) {
                  satisfied = true;
                  break;
                }
              } else if (!(evalRes.error && evalRes.error.code === 'OVERTY_JS_CONTEXT_LOST')) {
                return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);
              }
              await sleep(pollMs);
            }
            if (!satisfied) {
              return toolError('OVERTY_TIMEOUT', `navigate timed out waiting for waitUntil=${waitUntil}`, {
                waitUntil,
                timeoutMs,
                elapsedMs: Date.now() - start,
                lastState,
              });
            }
          }

          if (waitForText || waitForExpression) {
            const mode = waitForExpression ? 'expression' : 'text';
            const expr = waitForExpression
              ? waitForExpression
              : `(() => {
                   const needle = ${JSON.stringify(String(waitForText))};
                   const body = document.body;
                   const hay = body && typeof body.innerText === 'string' ? body.innerText : '';
                   return hay.includes(needle);
                 })()`;

            while (Date.now() - start <= timeoutMs) {
              const evalRes = await cdp.evaluate(expr, {
                returnByValue: true,
                awaitPromise: true,
                timeoutMs: Math.min(5_000, timeoutMs),
              });
              if (evalRes.ok) {
                const v = getRemoteObjectValue(evalRes.result);
                if (v) break;
              } else if (!(evalRes.error && evalRes.error.code === 'OVERTY_JS_CONTEXT_LOST')) {
                return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);
              }
              await sleep(pollMs);
            }

            if (Date.now() - start > timeoutMs) {
              return toolError('OVERTY_TIMEOUT', 'navigate timed out waiting for condition', { mode, timeoutMs, elapsedMs: Date.now() - start });
            }
          }

          const infoRes = await cdp.evaluate(
            `(() => ({ url: String(location.href), title: String(document.title || ''), readyState: String(document.readyState || '') }))()`,
            { returnByValue: true, awaitPromise: true, timeoutMs: Math.min(10_000, timeoutMs) },
          );
          const info = infoRes.ok ? getRemoteObjectValue(infoRes.result) : null;

          const elapsedMs = Date.now() - start;
          const summary = info && info.url ? `Navigated: ${info.url}` : `Navigated: ${String(url)}`;
          const extra = info && info.title ? `Title: ${info.title}` : null;

          return {
            content: [{ type: 'text', text: [summary, extra, `Elapsed: ${elapsedMs}ms`].filter(Boolean).join('\n') }],
            structuredContent: { url: info && info.url ? info.url : String(url), title: info && info.title ? info.title : null, readyState: info && info.readyState ? info.readyState : null, elapsedMs },
          };
        }

        case 'list_events': {
          const sinceSeq = args.sinceSeq;
          const limit = args.limit;
          const types = args.types;
          const clear = !!args.clear;

          const res = cdp.listEvents({ sinceSeq, limit, types, clear });
          if (!res.ok) return toolError('OVERTY_INTERNAL', 'Could not list events');

          const events = res.events || [];
          const lastSeq = events.length ? events[events.length - 1].seq : 0;

          return {
            content: [{ type: 'text', text: `Events: ${events.length}${lastSeq ? ` (last seq ${lastSeq})` : ''}` }],
            structuredContent: { events },
          };
        }

        case 'audit_layout': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const tolerancePx = Number.isFinite(args.tolerancePx) ? Math.max(0, Math.floor(args.tolerancePx)) : 1;
          const maxElements = Number.isFinite(args.maxElements) ? Math.max(1, Math.floor(args.maxElements)) : 30;
          const expr = buildAuditLayoutExpression(tolerancePx, maxElements);

          const evalRes = await cdp.evaluate(expr, { returnByValue: true, awaitPromise: true, timeoutMs: 30_000 });
          if (!evalRes.ok) return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);

          const ro = evalRes.result || {};
          const value = getRemoteObjectValue(ro) || {};
          const count = Array.isArray(value.overflowingElements) ? value.overflowingElements.length : 0;
          const overflow = value.document && value.document.horizontalOverflow ? 'yes' : 'no';

          return {
            content: [{ type: 'text', text: `audit_layout: horizontalOverflow=${overflow}, offenders=${count}` }],
            structuredContent: value,
          };
        }

        case 'assert_layout': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const topLevelRuleKeys = [
            'overflowTolerancePx',
            'maxHorizontalOverflowPx',
            'maxOverflowingElements',
            'maxClippedText',
            'maxOverlapCount',
            'maxTapTargetViolations',
            'minTapTargetPx',
            'overlapTolerancePx',
            'maxElements',
            'overlapCandidateLimit',
            'overlapSelector',
            'includeOverlaps',
          ];

          const rawRules = args.rules && typeof args.rules === 'object' && !Array.isArray(args.rules) ? { ...args.rules } : {};
          for (const key of topLevelRuleKeys) {
            if (Object.prototype.hasOwnProperty.call(args, key)) {
              rawRules[key] = args[key];
            }
          }

          const expr = buildAssertLayoutExpression(rawRules);
          const evalRes = await cdp.evaluate(expr, { returnByValue: true, awaitPromise: true, timeoutMs: 30_000 });
          if (!evalRes.ok) return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);

          const value = getRemoteObjectValue(evalRes.result) || {};
          const violationCount = Array.isArray(value.violations) ? value.violations.length : 0;
          const pass = !!value.pass;

          return {
            content: [{ type: 'text', text: `assert_layout: pass=${pass ? 'yes' : 'no'} violations=${violationCount}` }],
            structuredContent: value,
          };
        }

        case 'visual_diff': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const baselinePathArg = typeof args.baselinePath === 'string' ? args.baselinePath.trim() : '';
          if (!baselinePathArg) return toolError('OVERTY_INVALID_ARG', 'Missing required string argument: baselinePath');

          const baselinePath = resolveSafeOutputPath(baselinePathArg);
          if (!baselinePath) return toolError('OVERTY_INVALID_ARG', 'Invalid baselinePath');
          let baselineBuf;
          try {
            baselineBuf = fs.readFileSync(baselinePath);
          } catch (err) {
            return toolError('OVERTY_IO_ERROR', `Could not read baselinePath: ${baselinePath}`, String(err && err.message ? err.message : err));
          }
          const baselineDataUrl = dataUrlFromBuffer(baselineBuf, mimeFromPath(baselinePath, 'image/png'));

          const candidatePathArg = typeof args.candidatePath === 'string' && args.candidatePath.trim() ? args.candidatePath.trim() : null;
          let candidateDataUrl;
          let candidatePath = null;
          if (candidatePathArg) {
            candidatePath = resolveSafeOutputPath(candidatePathArg);
            if (!candidatePath) return toolError('OVERTY_INVALID_ARG', 'Invalid candidatePath');
            let candidateBuf;
            try {
              candidateBuf = fs.readFileSync(candidatePath);
            } catch (err) {
              return toolError('OVERTY_IO_ERROR', `Could not read candidatePath: ${candidatePath}`, String(err && err.message ? err.message : err));
            }
            candidateDataUrl = dataUrlFromBuffer(candidateBuf, mimeFromPath(candidatePath, 'image/png'));
          } else {
            const shot = await cdp.screenshot({
              format: args.format,
              quality: args.quality,
              fullPage: args.fullPage,
            });
            if (!shot.ok) return toolError(shot.error.code, shot.error.message, shot.error.details);
            const mime = shot.format === 'jpeg' ? 'image/jpeg' : `image/${shot.format}`;
            candidateDataUrl = `data:${mime};base64,${shot.base64}`;
          }

          const expr = buildVisualDiffExpression({
            baselineDataUrl,
            candidateDataUrl,
            threshold: args.threshold,
            includeDiff: true,
          });
          const evalRes = await cdp.evaluate(expr, { returnByValue: true, awaitPromise: true, timeoutMs: 60_000 });
          if (!evalRes.ok) return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);

          const value = getRemoteObjectValue(evalRes.result) || {};
          const diffPercent = Number.isFinite(value.diffPercent) ? Number(value.diffPercent) : null;
          if (diffPercent === null) return toolError('OVERTY_CDP_ERROR', 'visual_diff did not return diffPercent');

          const failPercent = Number.isFinite(args.failPercent) ? Math.max(0, Math.min(100, Number(args.failPercent))) : null;
          const failOnDimensionMismatch = !!args.failOnDimensionMismatch;
          let pass = true;
          if (failPercent !== null && diffPercent > failPercent) pass = false;
          if (failOnDimensionMismatch && value.dimensionMismatch) pass = false;

          const writeDiff = args.writeDiff === true || (!!args.diffPath && args.writeDiff !== false);
          let diffPath = null;
          let diffBytes = null;
          let diffBase64 = null;

          if (writeDiff || args.inlineDiff) {
            const diffBuf = parsePngDataUrl(value.diffDataUrl);
            if (!diffBuf) return toolError('OVERTY_CDP_ERROR', 'visual_diff did not produce a PNG diff image');
            diffBytes = diffBuf.length;
            const m = String(value.diffDataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
            diffBase64 = m ? m[1] : null;

            if (writeDiff) {
              const requestedDiffPath = args.diffPath ? String(args.diffPath) : path.join(DEFAULT_DIFF_DIR, `diff-${nowFileSafe()}.png`);
              diffPath = resolveSafeOutputPath(requestedDiffPath);
              if (!diffPath) return toolError('OVERTY_INVALID_ARG', 'Invalid diffPath');
              atomicWriteFileSync(diffPath, diffBuf);
            }
          }

          const lines = [
            `visual_diff: pass=${pass ? 'yes' : 'no'}`,
            `diffPercent=${diffPercent.toFixed(4)}%`,
            failPercent !== null ? `failPercent=${failPercent}%` : null,
            value.dimensionMismatch ? 'dimensionMismatch=yes' : 'dimensionMismatch=no',
            diffPath ? `diffPath=${diffPath}` : null,
          ].filter(Boolean);

          const content = [{ type: 'text', text: lines.join('\n') }];
          if (args.inlineDiff && diffBase64 && diffBytes < MAX_INLINE_SCREENSHOT_BYTES) {
            content.push({ type: 'image', data: diffBase64, mimeType: 'image/png' });
          }

          return {
            content,
            structuredContent: {
              pass,
              failPercent,
              failOnDimensionMismatch,
              baselinePath,
              candidatePath,
              diffPath,
              diffBytes,
              ...value,
            },
          };
        }

        case 'qa_matrix': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const defaultViewports = [
            { name: 'mobile', width: 390, height: 844, mobile: true, deviceScaleFactor: 1 },
            { name: 'tablet', width: 768, height: 1024, mobile: true, deviceScaleFactor: 1 },
            { name: 'desktop', width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 },
          ];

          const rawViewports = Array.isArray(args.viewports) && args.viewports.length ? args.viewports : defaultViewports;
          const normalizedViewports = [];
          for (let i = 0; i < rawViewports.length; i++) {
            const v = rawViewports[i] || {};
            const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : `viewport-${i + 1}`;
            const width = Number(v.width);
            const height = Number(v.height);
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
              return toolError('OVERTY_INVALID_ARG', `Invalid viewport width/height at index ${i}`);
            }
            normalizedViewports.push({
              name,
              width: Math.floor(width),
              height: Math.floor(height),
              mobile: !!v.mobile,
              deviceScaleFactor: Number.isFinite(Number(v.deviceScaleFactor)) && Number(v.deviceScaleFactor) > 0 ? Number(v.deviceScaleFactor) : 1,
              fullPage: typeof v.fullPage === 'boolean' ? v.fullPage : null,
              waitMs: Number.isFinite(Number(v.waitMs)) ? Math.max(0, Math.floor(Number(v.waitMs))) : null,
            });
          }

          const format = args.format ? String(args.format) : 'png';
          const quality = args.quality;
          const defaultFullPage = !!args.fullPage;
          const defaultWaitMs = Number.isFinite(Number(args.waitMs)) ? Math.max(0, Math.floor(Number(args.waitMs))) : 120;
          const includeLayoutAudit = args.includeLayoutAudit !== false;
          const includeAssertions = args.includeAssertions !== false;
          const includeEvents = args.includeEvents !== false;
          const eventsLimit = Number.isFinite(Number(args.eventsLimit)) ? Math.max(1, Math.floor(Number(args.eventsLimit))) : 150;
          const writeManifest = args.writeManifest !== false;
          const clearViewportAtEnd = args.clearViewportAtEnd !== false;
          const inlineLimit = Number.isFinite(Number(args.inlineLimit)) ? Math.max(0, Math.floor(Number(args.inlineLimit))) : 0;

          const outputDir = args.outputDir
            ? resolveSafeOutputPath(String(args.outputDir))
            : path.join(DEFAULT_MATRIX_DIR, nowFileSafe());
          if (!outputDir || !isSafeOutputPath(outputDir)) return toolError('OVERTY_INVALID_ARG', 'Invalid outputDir');
          ensureDirSync(outputDir);

          const assertRules = args.assertRules && typeof args.assertRules === 'object' && !Array.isArray(args.assertRules) ? args.assertRules : {};

          const createdAt = new Date().toISOString();
          const results = [];
          const failures = [];
          const inlineImages = [];
          const ext = format === 'jpeg' ? 'jpg' : format;

          for (let i = 0; i < normalizedViewports.length; i++) {
            const vp = normalizedViewports[i];
            const seqStart = includeEvents ? cdp._eventSeq : null;
            try {
              const vpRes = await cdp.setViewport({
                width: vp.width,
                height: vp.height,
                mobile: vp.mobile,
                deviceScaleFactor: vp.deviceScaleFactor,
              });
              if (!vpRes.ok) throw new Error(`[${vpRes.error.code}] ${vpRes.error.message}`);

              const waitMs = vp.waitMs !== null ? vp.waitMs : defaultWaitMs;
              if (waitMs > 0) await sleep(waitMs);

              const shot = await cdp.screenshot({
                format,
                quality,
                fullPage: vp.fullPage === null ? defaultFullPage : vp.fullPage,
              });
              if (!shot.ok) throw new Error(`[${shot.error.code}] ${shot.error.message}`);

              const bytes = Buffer.from(shot.base64, 'base64');
              const fileName = `${String(i + 1).padStart(2, '0')}-${sanitizeFileBase(vp.name)}.${ext}`;
              const filePath = path.join(outputDir, fileName);
              atomicWriteFileSync(filePath, bytes);

              let events = null;
              let eventSummary = null;
              if (includeEvents && typeof seqStart === 'number') {
                const evRes = cdp.listEvents({ sinceSeq: seqStart, limit: eventsLimit, types: ['console', 'exception', 'log'] });
                if (evRes.ok) {
                  events = evRes.events || [];
                  eventSummary = summarizeEvents(events);
                }
              }

              let layoutAudit = null;
              if (includeLayoutAudit) {
                const evalRes = await cdp.evaluate(buildAuditLayoutExpression(1, 30), {
                  returnByValue: true,
                  awaitPromise: true,
                  timeoutMs: 30_000,
                });
                if (!evalRes.ok) throw new Error(`[${evalRes.error.code}] ${evalRes.error.message}`);
                layoutAudit = getRemoteObjectValue(evalRes.result) || null;
              }

              let assertion = null;
              if (includeAssertions) {
                const evalRes = await cdp.evaluate(buildAssertLayoutExpression(assertRules), {
                  returnByValue: true,
                  awaitPromise: true,
                  timeoutMs: 30_000,
                });
                if (!evalRes.ok) throw new Error(`[${evalRes.error.code}] ${evalRes.error.message}`);
                assertion = getRemoteObjectValue(evalRes.result) || null;
              }

              results.push({
                viewport: {
                  name: vp.name,
                  width: vp.width,
                  height: vp.height,
                  mobile: vp.mobile,
                  deviceScaleFactor: vp.deviceScaleFactor,
                },
                screenshot: {
                  fileName,
                  filePath,
                  bytes: bytes.length,
                  format: shot.format,
                  fullPage: vp.fullPage === null ? defaultFullPage : vp.fullPage,
                },
                eventSummary,
                eventCount: events ? events.length : null,
                layoutAudit,
                assertion,
              });

              if (inlineLimit > 0 && inlineImages.length < inlineLimit && bytes.length < MAX_INLINE_SCREENSHOT_BYTES) {
                inlineImages.push({ type: 'image', data: shot.base64, mimeType: `image/${shot.format}` });
              }
            } catch (err) {
              failures.push({
                viewport: { name: vp.name, width: vp.width, height: vp.height },
                error: String(err && err.message ? err.message : err),
              });
            }
          }

          if (clearViewportAtEnd) {
            try {
              await cdp.clearViewport();
            } catch {
              // best-effort cleanup
            }
          }

          const assertionPassedCount = includeAssertions
            ? results.filter((r) => r.assertion && r.assertion.pass).length
            : null;
          const overallPass = includeAssertions
            ? failures.length === 0 && assertionPassedCount === results.length
            : failures.length === 0;

          let manifestPath = null;
          if (writeManifest) {
            manifestPath = path.join(outputDir, 'manifest.json');
            const outputDirDisplay = path.relative(process.cwd(), outputDir) || outputDir;
            const manifest = {
              schemaVersion: 1,
              createdAt,
              serverInfo: SERVER_INFO,
              browserUrl: cdp.browserUrl || null,
              selectedTarget: cdp.selectedTarget || null,
              outputDir: outputDirDisplay,
              includeLayoutAudit,
              includeAssertions,
              includeEvents,
              assertRules: includeAssertions ? normalizeAssertLayoutRules(assertRules) : null,
              overallPass,
              counts: {
                viewports: normalizedViewports.length,
                succeeded: results.length,
                failed: failures.length,
                assertionPassed: assertionPassedCount,
              },
              results: results.map((r) => ({
                viewport: r.viewport,
                screenshot: {
                  fileName: path.basename(String(r.screenshot.filePath)),
                  bytes: r.screenshot.bytes,
                  format: r.screenshot.format,
                  fullPage: r.screenshot.fullPage,
                },
                eventSummary: r.eventSummary,
                eventCount: r.eventCount,
                layoutAudit: r.layoutAudit,
                assertion: r.assertion,
              })),
              failures,
            };
            atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
          }

          const lines = [
            `qa_matrix: ${results.length}/${normalizedViewports.length} viewports captured`,
            `overallPass=${overallPass ? 'yes' : 'no'}`,
            includeAssertions ? `assertionPassed=${assertionPassedCount}/${results.length}` : null,
            failures.length ? `failures=${failures.length}` : null,
            `outputDir=${outputDir}`,
            manifestPath ? `manifestPath=${manifestPath}` : null,
          ].filter(Boolean);

          return {
            content: [{ type: 'text', text: lines.join('\n') }, ...inlineImages],
            structuredContent: {
              createdAt,
              outputDir,
              manifestPath,
              overallPass,
              includeLayoutAudit,
              includeAssertions,
              includeEvents,
              results,
              failures,
            },
          };
        }

        case 'capture_bundle': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const label = typeof args.label === 'string' && args.label.trim() ? sanitizeFileBase(args.label) : 'bundle';
          const outputDir = args.outputDir
            ? resolveSafeOutputPath(String(args.outputDir))
            : path.join(DEFAULT_BUNDLE_DIR, `${nowFileSafe()}-${label}`);
          if (!outputDir || !isSafeOutputPath(outputDir)) return toolError('OVERTY_INVALID_ARG', 'Invalid outputDir');
          ensureDirSync(outputDir);

          const createdAt = new Date().toISOString();

          const shot = await cdp.screenshot({
            format: args.format,
            quality: args.quality,
            fullPage: args.fullPage,
          });
          if (!shot.ok) return toolError(shot.error.code, shot.error.message, shot.error.details);

          const bytes = Buffer.from(shot.base64, 'base64');
          const ext = shot.format === 'jpeg' ? 'jpg' : shot.format;
          const screenshotPath = path.join(outputDir, `screenshot.${ext}`);
          atomicWriteFileSync(screenshotPath, bytes);

          const includeDom = args.includeDom !== false;
          let domPath = null;
          let domMeta = null;
          if (includeDom) {
            const snapRes = await cdp.outerHtml(args.domSelector, args.domMaxChars, 30_000);
            if (!snapRes.ok) return toolError(snapRes.error.code, snapRes.error.message, snapRes.error.details);
            domPath = path.join(outputDir, 'dom.html');
            const body = snapRes.html === null ? '(null)' : snapRes.html;
            atomicWriteFileSync(domPath, `${body}\n`);
            domMeta = {
              selector: args.domSelector ? String(args.domSelector) : null,
              truncated: !!snapRes.truncated,
              chars: snapRes.chars,
            };
          }

          const includeEvents = args.includeEvents !== false;
          let eventsPath = null;
          let eventsSummary = null;
          let eventsCount = null;
          if (includeEvents) {
            const sinceSeq = args.eventsSinceSeq;
            const limit = Number.isFinite(args.eventsLimit) ? Math.max(1, Math.floor(args.eventsLimit)) : 200;
            const types = Array.isArray(args.eventsTypes) ? args.eventsTypes : ['console', 'exception', 'log'];
            const clear = !!args.clearEvents;

            const evRes = cdp.listEvents({ sinceSeq, limit, types, clear });
            if (!evRes.ok) return toolError('OVERTY_INTERNAL', 'Could not list events');
            const events = evRes.events || [];
            eventsCount = events.length;
            eventsSummary = summarizeEvents(events);
            eventsPath = path.join(outputDir, 'events.json');
            atomicWriteFileSync(eventsPath, `${JSON.stringify({ events }, null, 2)}\n`);
          }

          const includeLayoutAudit = args.includeLayoutAudit !== false;
          let layoutPath = null;
          let layoutSummary = null;
          if (includeLayoutAudit) {
            const tolerancePx = Number.isFinite(args.tolerancePx) ? Math.max(0, Math.floor(args.tolerancePx)) : 1;
            const maxElements = Number.isFinite(args.maxElements) ? Math.max(1, Math.floor(args.maxElements)) : 30;
            const expr = buildAuditLayoutExpression(tolerancePx, maxElements);
            const evalRes = await cdp.evaluate(expr, { returnByValue: true, awaitPromise: true, timeoutMs: 30_000 });
            if (!evalRes.ok) return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);
            const ro = evalRes.result || {};
            const value = getRemoteObjectValue(ro) || {};
            layoutSummary = value;
            layoutPath = path.join(outputDir, 'layout.json');
            atomicWriteFileSync(layoutPath, `${JSON.stringify(value, null, 2)}\n`);
          }

          const outputDirDisplay = path.relative(process.cwd(), outputDir) || outputDir;
          const manifestPath = path.join(outputDir, 'bundle.json');
          const manifest = {
            schemaVersion: 1,
            createdAt,
            serverInfo: SERVER_INFO,
            browserUrl: cdp.browserUrl || null,
            selectedTarget: cdp.selectedTarget || null,
            outputDir: outputDirDisplay,
            screenshot: { path: path.basename(screenshotPath), bytes: bytes.length, format: shot.format, fullPage: !!args.fullPage },
            dom: includeDom ? { path: domPath ? path.basename(domPath) : null, ...domMeta } : null,
            events: includeEvents ? { path: eventsPath ? path.basename(eventsPath) : null, count: eventsCount, summary: eventsSummary } : null,
            layout: includeLayoutAudit ? { path: layoutPath ? path.basename(layoutPath) : null } : null,
          };
          atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

          const lines = [
            `Bundle: ${outputDir}`,
            `Screenshot: ${screenshotPath}`,
            domPath ? `DOM: ${domPath}` : null,
            eventsPath ? `Events: ${eventsPath}` : null,
            layoutPath ? `Layout: ${layoutPath}` : null,
            `Manifest: ${manifestPath}`,
          ].filter(Boolean);

          const content = [{ type: 'text', text: lines.join('\n') }];
          if (args.inlineScreenshot && bytes.length < MAX_INLINE_SCREENSHOT_BYTES) {
            content.push({ type: 'image', data: shot.base64, mimeType: `image/${shot.format}` });
          }

          return {
            content,
            structuredContent: {
              outputDir,
              createdAt,
              screenshotPath,
              domPath,
              eventsPath,
              layoutPath,
              manifestPath,
              eventsSummary,
              layoutSummary,
            },
          };
        }

        case 'render_html_mockups': {
          const html = args.html;
          const variants = args.variants;
          if (typeof html !== 'string') return toolError('OVERTY_INVALID_ARG', 'Missing required string argument: html');
          if (!Array.isArray(variants) || variants.length === 0) {
            return toolError('OVERTY_INVALID_ARG', 'Missing required array argument: variants');
          }

          const allowRemote = !!args.allowRemote;
          const rawBrowserUrl = args.browserUrl || cdp.browserUrl || DEFAULT_BROWSER_URL;
          const guard = requireLoopbackUnlessAllowed(rawBrowserUrl, allowRemote);
          if (!guard.ok) return toolError(guard.error.code, guard.error.message, guard.error.details);
          const browserBase = toCdpHttpBase(guard.url.toString());

          const keepPageOpen = !!args.keepPageOpen;
          const restorePreviousTarget = args.restorePreviousTarget !== false;

          const previous =
            cdp.isConnected && cdp.selectedTarget && cdp.selectedTarget.id
              ? { browserUrl: cdp.browserUrl || browserBase, targetId: String(cdp.selectedTarget.id) }
              : null;

          const format = args.format ? String(args.format) : 'png';
          const quality = args.quality;
          const ext = format === 'jpeg' ? 'jpg' : format;

          const outputDir = args.outputDir
            ? resolveSafeOutputPath(String(args.outputDir))
            : path.join(DEFAULT_MOCKUP_DIR, nowFileSafe());
          if (!outputDir || !isSafeOutputPath(outputDir)) return toolError('OVERTY_INVALID_ARG', 'Invalid outputDir');
          ensureDirSync(outputDir);

          let mockTarget = null;
          let mockTargetClosed = false;
          let restoreAttempted = false;

          try {
            const newPage = await cdpHttpNewPage({ browserUrl: browserBase, allowRemote, url: 'about:blank' });
            if (!newPage.ok) return toolError(newPage.error.code, newPage.error.message, newPage.error.details);
            mockTarget = newPage.target;

            const actRes = await cdpHttpActivate({ browserUrl: browserBase, allowRemote, targetId: mockTarget.id });
            if (!actRes.ok) log('render_html_mockups: activate failed', actRes.error);

            const conn = await cdp.connect({ browserUrl: browserBase, allowRemote, targetId: mockTarget.id });
            if (!conn.ok) return toolError(conn.error.code, conn.error.message, conn.error.details);

            if (args.viewport && typeof args.viewport === 'object') {
              const v = args.viewport;
              const vpRes = await cdp.setViewport({
                width: v.width,
                height: v.height,
                deviceScaleFactor: v.deviceScaleFactor,
                mobile: v.mobile,
              });
              if (!vpRes.ok) return toolError(vpRes.error.code, vpRes.error.message, vpRes.error.details);
            }

            const setHtmlRes = await cdp.evaluate(buildSetHtmlExpression(html), { returnByValue: true, awaitPromise: true, timeoutMs: 30_000 });
            if (!setHtmlRes.ok) return toolError(setHtmlRes.error.code, setHtmlRes.error.message, setHtmlRes.error.details);

            // Wait for fonts to settle (best-effort).
            await cdp.evaluate(
              `(async () => { try { if (document.fonts && document.fonts.ready) { await document.fonts.ready; } } catch (e) {} return true; })()`,
              { returnByValue: true, awaitPromise: true, timeoutMs: 30_000 },
            );
            await sleep(50);

            const baseCss = typeof args.baseCss === 'string' ? args.baseCss : '';
            const results = [];
            const failures = [];
            const writeHtmlFiles = args.writeHtmlFiles !== false;
            const writeManifest = args.writeManifest !== false;
            const writeIndexHtml = args.writeIndexHtml !== false;
            const indexTitle = typeof args.indexTitle === 'string' && args.indexTitle.trim() ? args.indexTitle.trim() : null;
            const includeEventSummary = args.includeEventSummary !== false;
            const inlineLimit = Number.isFinite(args.inlineLimit) ? Math.max(0, Math.floor(args.inlineLimit)) : 0;
            const inlineImages = [];
            const createdAt = new Date().toISOString();

            for (let i = 0; i < variants.length; i++) {
              const v = variants[i] || {};
              const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : `variant-${i + 1}`;
              const css = typeof v.css === 'string' ? v.css : '';
              const js = typeof v.js === 'string' ? v.js : '';
              const waitMs = Number.isFinite(v.waitMs) ? Math.max(0, Math.floor(Number(v.waitMs))) : 100;
              const fullPage = !!v.fullPage;

              try {
                const combinedCss = [baseCss, css].filter(Boolean).join('\n');

                let htmlPath = null;
                let htmlFileName = null;
                if (writeHtmlFiles) {
                  htmlFileName = `${String(i + 1).padStart(2, '0')}-${sanitizeFileBase(name)}.html`;
                  htmlPath = path.join(outputDir, htmlFileName);
                  const htmlText = injectStyleIntoHtml(html, combinedCss, DEFAULT_STYLE_ID);
                  atomicWriteFileSync(htmlPath, htmlText);
                }

                const seqStart = includeEventSummary ? cdp._eventSeq : null;

                const cssRes = await cdp.evaluate(buildSetCssExpression(DEFAULT_STYLE_ID, combinedCss, 'replace'), {
                  returnByValue: true,
                  awaitPromise: true,
                  timeoutMs: 30_000,
                });
                if (!cssRes.ok) throw new Error(`[${cssRes.error.code}] ${cssRes.error.message}`);

                if (js) {
                  const jsRes = await cdp.evaluate(String(js), { returnByValue: true, awaitPromise: true, timeoutMs: 30_000 });
                  if (!jsRes.ok) throw new Error(`[${jsRes.error.code}] ${jsRes.error.message}`);
                }

                if (waitMs > 0) await sleep(waitMs);

                const shot = await cdp.screenshot({ format, quality, fullPage });
                if (!shot.ok) throw new Error(`[${shot.error.code}] ${shot.error.message}`);
                const bytes = Buffer.from(shot.base64, 'base64');

                const fileName = `${String(i + 1).padStart(2, '0')}-${sanitizeFileBase(name)}.${ext}`;
                const filePath = path.join(outputDir, fileName);
                atomicWriteFileSync(filePath, bytes);

                let eventSummary = null;
                let eventSeq = null;
                if (includeEventSummary && typeof seqStart === 'number') {
                  const evRes = cdp.listEvents({ sinceSeq: seqStart, limit: 200, types: ['console', 'exception', 'log'] });
                  if (evRes && evRes.ok) {
                    eventSummary = summarizeEvents(evRes.events || []);
                    eventSeq = { start: seqStart, end: cdp._eventSeq };
                  }
                }

                results.push({
                  name,
                  fileName,
                  filePath,
                  htmlFileName,
                  htmlPath,
                  bytes: bytes.length,
                  format: shot.format,
                  fullPage,
                  eventSummary,
                  eventSeq,
                });

                if (inlineLimit > 0 && inlineImages.length < inlineLimit && bytes.length < MAX_INLINE_SCREENSHOT_BYTES) {
                  inlineImages.push({ type: 'image', data: shot.base64, mimeType: `image/${shot.format}` });
                }
              } catch (err) {
                failures.push({ name, error: String(err && err.message ? err.message : err) });
              }
            }

            if (!keepPageOpen) {
              const closeRes = await cdpHttpClose({ browserUrl: browserBase, allowRemote, targetId: mockTarget.id });
              if (!closeRes.ok) log('render_html_mockups: close failed', closeRes.error);
              if (closeRes.ok) mockTargetClosed = true;
              await sleep(50);
            }

            let restored = null;
            if (previous && restorePreviousTarget) {
              restoreAttempted = true;
              const prevConn = await cdp.connect({ browserUrl: previous.browserUrl, allowRemote, targetId: previous.targetId });
              restored = prevConn.ok
                ? { ok: true, selectedTarget: prevConn.selectedTarget }
                : { ok: false, error: prevConn.error };
              if (!prevConn.ok) log('render_html_mockups: restore failed', prevConn.error);
            }

            const lines = [
              `Rendered ${results.length}/${variants.length} variants`,
              `Output: ${outputDir}`,
              failures.length ? `Failures: ${failures.length}` : null,
              keepPageOpen ? `Mockup targetId: ${mockTarget.id}` : null,
            ].filter(Boolean);

            const outputDirDisplay = path.relative(process.cwd(), outputDir) || outputDir;

            let manifestPath = null;
            if (writeManifest) {
              manifestPath = path.join(outputDir, 'manifest.json');
              const manifest = {
                schemaVersion: 1,
                createdAt,
                serverInfo: SERVER_INFO,
                browserUrl: browserBase,
                outputDir: outputDirDisplay,
                mockTargetId: mockTarget.id,
                writeHtmlFiles,
                writeIndexHtml,
                includeEventSummary,
                results: results.map((r) => ({
                  name: r.name,
                  fileName: r.fileName || (r.filePath ? path.basename(String(r.filePath)) : null),
                  htmlFileName: r.htmlFileName || (r.htmlPath ? path.basename(String(r.htmlPath)) : null),
                  bytes: r.bytes,
                  format: r.format,
                  fullPage: r.fullPage,
                  eventSummary: r.eventSummary,
                })),
                failures,
              };
              atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
              lines.push(`Manifest: ${manifestPath}`);
            }

            let indexPath = null;
            if (writeIndexHtml) {
              indexPath = path.join(outputDir, 'index.html');
              const indexHtml = buildMockupsIndexHtml({
                title: indexTitle || 'overty mockups',
                createdAt,
                outputDir: outputDirDisplay,
                results,
                failures,
              });
              atomicWriteFileSync(indexPath, indexHtml);
              lines.push(`Index: ${indexPath}`);
            }

            return {
              content: [{ type: 'text', text: lines.join('\n') }, ...inlineImages],
              structuredContent: {
                browserUrl: browserBase,
                outputDir,
                mockTargetId: mockTarget.id,
                createdAt,
                results,
                failures,
                restored,
                manifestPath,
                indexPath,
              },
            };
          } finally {
            if (mockTarget && !keepPageOpen && !mockTargetClosed) {
              const closeRes = await cdpHttpClose({ browserUrl: browserBase, allowRemote, targetId: mockTarget.id });
              if (!closeRes.ok) log('render_html_mockups: close failed', closeRes.error);
            }
            if (previous && restorePreviousTarget && !restoreAttempted) {
              const prevConn = await cdp.connect({ browserUrl: previous.browserUrl, allowRemote, targetId: previous.targetId });
              if (!prevConn.ok) log('render_html_mockups: restore failed', prevConn.error);
            }
          }
        }

        case 'execute_js': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const expression = args.expression;
          if (typeof expression !== 'string' || !expression.trim()) {
            return toolError('OVERTY_INVALID_ARG', 'Missing required string argument: expression');
          }

          const evalRes = await cdp.evaluate(expression, {
            awaitPromise: args.awaitPromise,
            returnByValue: args.returnByValue,
            timeoutMs: args.timeoutMs,
          });

          if (!evalRes.ok) return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);

          const ro = evalRes.result || {};
          const summary =
            Object.prototype.hasOwnProperty.call(ro, 'value')
              ? JSON.stringify(ro.value)
              : ro.description
                ? String(ro.description)
                : `[${ro.type || 'unknown'}]`;

          return {
            content: [{ type: 'text', text: summary }],
            structuredContent: { remoteObject: ro },
          };
        }

        case 'take_dom_snapshot': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 30_000;
          const snapRes = await cdp.outerHtml(args.selector, args.maxChars, timeoutMs);
          if (!snapRes.ok) return toolError(snapRes.error.code, snapRes.error.message, snapRes.error.details);

          const header = snapRes.truncated ? `HTML (truncated, ${snapRes.chars} chars total):` : `HTML (${snapRes.chars} chars):`;
          const body = snapRes.html === null ? '(null)' : snapRes.html;

          return {
            content: [{ type: 'text', text: `${header}\n${body}` }],
            structuredContent: {
              html: snapRes.html,
              truncated: snapRes.truncated,
              chars: snapRes.chars,
              selector: args.selector ? String(args.selector) : null,
            },
          };
        }

        case 'take_screenshot': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');

          const shot = await cdp.screenshot({
            format: args.format,
            quality: args.quality,
            fullPage: args.fullPage,
          });
          if (!shot.ok) return toolError(shot.error.code, shot.error.message, shot.error.details);

          const bytes = Buffer.from(shot.base64, 'base64');
          const ext = shot.format === 'jpeg' ? 'jpg' : shot.format;

          const requestedPath = args.filePath ? String(args.filePath).trim() : null;
          const safeRequestedPath = requestedPath ? resolveSafeOutputPath(requestedPath) : null;
          if (requestedPath && !safeRequestedPath) return toolError('OVERTY_INVALID_ARG', 'Invalid filePath');
          const shouldInline = bytes.length < MAX_INLINE_SCREENSHOT_BYTES && !requestedPath;

          if (!shouldInline) {
            const filePath = safeRequestedPath || path.join(DEFAULT_SCREENSHOT_DIR, `screenshot-${nowFileSafe()}.${ext}`);
            if (!isSafeOutputPath(filePath)) return toolError('OVERTY_INVALID_ARG', 'Invalid filePath');
            atomicWriteFileSync(filePath, bytes);
            return {
              content: [{ type: 'text', text: `Saved screenshot to ${filePath}` }],
              structuredContent: { filePath, bytes: bytes.length, format: shot.format },
            };
          }

          return {
            content: [{ type: 'image', data: shot.base64, mimeType: `image/${shot.format}` }],
            structuredContent: { bytes: bytes.length, format: shot.format },
          };
        }

        case 'screenshot_element': {
          if (!cdp.isConnected) return toolError('OVERTY_NOT_CONNECTED', 'Not connected. Call connect() first.');
          const selector = args.selector;
          if (typeof selector !== 'string' || !selector.trim()) {
            return toolError('OVERTY_INVALID_ARG', 'Missing required string argument: selector');
          }

          const index = Number.isFinite(args.index) ? Math.max(0, Math.floor(args.index)) : 0;
          const paddingPx = Number.isFinite(args.paddingPx) ? Math.max(0, Number(args.paddingPx)) : 0;
          const scrollIntoView = args.scrollIntoView !== false;
          const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(0, Math.floor(args.timeoutMs)) : 30_000;

          const expr = `(() => {
            const sel = ${JSON.stringify(String(selector))};
            const idx = ${index};
            const els = document.querySelectorAll(sel);
            const el = els && els.length > idx ? els[idx] : null;
            if (!el) return { found: false, count: els ? els.length : 0 };
            try {
              if (${scrollIntoView ? 'true' : 'false'}) {
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              }
            } catch (e) {}
            const r = el.getBoundingClientRect();
            const de = document.documentElement;
            const vw = de ? de.clientWidth : window.innerWidth;
            const vh = de ? de.clientHeight : window.innerHeight;
            return {
              found: true,
              count: els ? els.length : 1,
              rect: { x: r.left, y: r.top, width: r.width, height: r.height },
              viewport: { width: vw, height: vh },
            };
          })()`;

          const evalRes = await cdp.evaluate(expr, { returnByValue: true, awaitPromise: true, timeoutMs });
          if (!evalRes.ok) return toolError(evalRes.error.code, evalRes.error.message, evalRes.error.details);

          const info = getRemoteObjectValue(evalRes.result) || null;
          if (!info || !info.found) {
            return toolError('OVERTY_NOT_FOUND', `No element matched selector: ${String(selector)}`, {
              selector: String(selector),
              index,
              count: info && Number.isFinite(info.count) ? info.count : null,
            });
          }

          const rect = info.rect || {};
          const viewport = info.viewport || {};
          const vw = Number(viewport.width);
          const vh = Number(viewport.height);
          const rx = Number(rect.x);
          const ry = Number(rect.y);
          const rw = Number(rect.width);
          const rh = Number(rect.height);
          if (![vw, vh, rx, ry, rw, rh].every((n) => Number.isFinite(n))) {
            return toolError('OVERTY_CDP_ERROR', 'Could not compute element bounding box');
          }

          const x0 = Math.max(0, rx - paddingPx);
          const y0 = Math.max(0, ry - paddingPx);
          const x1 = Math.min(vw, rx + rw + paddingPx);
          const y1 = Math.min(vh, ry + rh + paddingPx);
          const clipW = Math.max(1, x1 - x0);
          const clipH = Math.max(1, y1 - y0);

          const shot = await cdp.screenshotClip({
            x: x0,
            y: y0,
            width: clipW,
            height: clipH,
            format: args.format,
            quality: args.quality,
          });
          if (!shot.ok) return toolError(shot.error.code, shot.error.message, shot.error.details);

          const bytes = Buffer.from(shot.base64, 'base64');
          const ext = shot.format === 'jpeg' ? 'jpg' : shot.format;

          const requestedPath = args.filePath ? String(args.filePath) : null;
          const shouldInline = bytes.length < MAX_INLINE_SCREENSHOT_BYTES && !requestedPath;
          const safeRequestedPath = requestedPath ? resolveSafeOutputPath(requestedPath.trim()) : null;
          if (requestedPath && !safeRequestedPath) return toolError('OVERTY_INVALID_ARG', 'Invalid filePath');

          const meta = {
            selector: String(selector),
            index,
            paddingPx,
            rect: { x: rx, y: ry, width: rw, height: rh },
            clip: { x: x0, y: y0, width: clipW, height: clipH },
            viewport: { width: vw, height: vh },
            bytes: bytes.length,
            format: shot.format,
          };

          if (!shouldInline) {
            const filePath = safeRequestedPath || path.join(DEFAULT_SCREENSHOT_DIR, `element-${sanitizeFileBase(selector)}-${nowFileSafe()}.${ext}`);
            if (!isSafeOutputPath(filePath)) return toolError('OVERTY_INVALID_ARG', 'Invalid filePath');
            atomicWriteFileSync(filePath, bytes);
            return {
              content: [{ type: 'text', text: `Saved element screenshot to ${filePath}` }],
              structuredContent: { ...meta, filePath },
            };
          }

          return {
            content: [{ type: 'image', data: shot.base64, mimeType: `image/${shot.format}` }],
            structuredContent: meta,
          };
        }

        default:
          // Spec recommends MCP error response for missing tool. Here we provide a
          // protocol-level InvalidParams error so clients can surface it properly.
          throw Object.assign(new Error(`Tool not found: ${name}`), { _mcpCode: -32602 });
      }
    }

    case 'notifications/initialized': {
      // Nothing to do.
      return undefined;
    }

    default: {
      // Method not found (protocol-level).
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { _mcpCode: -32601 });
    }
  }
}

const server = new JsonRpcLineServer(handleRequest);

(async () => {
  if (OVERTY_WITH_CHROME_DEVTOOLS) {
    try {
      await startChromeDevtoolsMcpChild();
    } catch (err) {
      log('Failed to start chrome-devtools-mcp sidecar:', err && err.message ? err.message : err);
    }
  }

  const teardown = async () => {
    if (chromeDevtoolsProcess) {
      await shutdownChromeDevtoolsMcpChild();
    }
    await cdp.disconnect();
  };

  process.on('SIGINT', async () => {
    log('SIGINT: closing CDP session + optional sidecars');
    await teardown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('SIGTERM: closing CDP session + optional sidecars');
    await teardown();
    process.exit(0);
  });

  log('MCP server running on stdio');
  server.start();
})(); 
