#!/usr/bin/env node
/**
 * 本機預覽伺服器
 *
 * 網頁需以 http:// 開啟才能讀取資料檔（file:// 會被瀏覽器的同源政策擋下）。
 *
 *   node tools/serve.mjs
 *   → http://localhost:8080/public/index.html
 *
 * 僅供本機開發預覽，正式部署使用 GitHub Pages。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/public/index.html';

    // 路徑逃逸防護：正規化後必須仍在專案目錄內
    const full = normalize(join(ROOT, path));
    if (!full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const st = await stat(full).catch(() => null);
    if (!st || st.isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 找不到：' + path);
      return;
    }

    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n  預覽伺服器已啟動\n`);
  console.log(`    公開看板   http://localhost:${PORT}/public/index.html`);
  console.log(`    歷史查詢   http://localhost:${PORT}/public/history.html`);
  console.log(`    結果驗證   http://localhost:${PORT}/public/verify.html`);
  console.log(`\n  以示範資料檢視（先執行 node tools/seed-demo.mjs）：`);
  console.log(`    http://localhost:${PORT}/public/index.html?src=../demo/\n`);
});
