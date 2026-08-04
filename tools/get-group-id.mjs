#!/usr/bin/env node
/**
 * 取得 LINE 群組 ID
 * SPEC.md §10.2
 *
 *   node tools/get-group-id.mjs [--port 3000]
 *
 * LINE 沒有提供「列出 bot 所在群組」的 API，群組 ID 只能從 webhook 事件取得。
 * 本工具在你自己的電腦上開一個臨時接收器，把收到的事件解析出來，
 * **資料不經任何第三方服務**。
 *
 * ── 使用步驟 ─────────────────────────────────────────────────
 *
 * 1. 執行本程式
 * 2. 讓這個連接埠可從網際網路連入（擇一）：
 *      cloudflared tunnel --url http://localhost:3000
 *      ngrok http 3000
 * 3. 把上一步得到的網址 + /webhook 填入
 *      LINE Developers → 你的 channel → Messaging API → Webhook URL
 *    並開啟「Use webhook」
 * 4. 在群組裡隨便說一句話（例如「test」）
 * 5. 本程式會印出群組 ID
 * 6. 取得後請把 Webhook URL 清空或關閉，本程式按 Ctrl+C 結束
 *
 * ── 關於 Channel Secret ─────────────────────────────────────
 *
 * 若設定環境變數 LINE_CHANNEL_SECRET，本程式會驗證每個請求的簽章，
 * 確認確實來自 LINE 而非他人偽造。這是選用的，不設也能運作。
 *
 *   $env:LINE_CHANNEL_SECRET = "你的 channel secret"   # PowerShell
 *
 * Channel Secret 只留在你自己的電腦上，本程式不會輸出它，也不會外傳。
 */

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(portArg === -1 ? 3000 : argv[portArg + 1]);

const SECRET = process.env.LINE_CHANNEL_SECRET || null;
const found = new Map();

function verifySignature(rawBody, signature) {
  if (!SECRET) return null; // 未設定則不驗證
  if (!signature) return false;
  const expected = createHmac('sha256', SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

function describe(source) {
  switch (source?.type) {
    case 'group': return { type: 'group', id: source.groupId, label: '群組', key: 'groupId' };
    case 'room': return { type: 'room', id: source.roomId, label: '聊天室', key: 'roomId' };
    case 'user': return { type: 'user', id: source.userId, label: '個人', key: 'userId' };
    default: return null;
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('LINE webhook 接收器運作中。請將 LINE 的 Webhook URL 指向本網址的 /webhook');
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);

    // 先回 200，否則 LINE 會判定 webhook 失敗
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OK');

    const sigOk = verifySignature(raw, req.headers['x-line-signature']);
    if (sigOk === false) {
      console.log('\n  ⚠ 簽章驗證失敗，已忽略這個請求（可能不是來自 LINE）');
      return;
    }

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      console.log('\n  ⚠ 收到的內容不是合法 JSON，已忽略');
      return;
    }

    for (const ev of body.events ?? []) {
      const d = describe(ev.source);
      if (!d || !d.id) continue;
      if (found.has(d.id)) continue;
      found.set(d.id, d);

      console.log('\n' + '─'.repeat(64));
      console.log(`  來源：${d.label}　事件：${ev.type}`);
      console.log(`  ${d.key}：`);
      console.log('');
      console.log(`      ${d.id}`);
      console.log('');
      if (sigOk === true) console.log('  ✓ 簽章驗證通過，確認來自 LINE');
      else console.log('  （未設定 LINE_CHANNEL_SECRET，未驗證簽章）');

      if (d.type !== 'user') {
        console.log('');
        console.log('  下一步：把上面這串填入 GitHub Secret「LINE_GROUP_IDS」');
        console.log('  Settings → Secrets and variables → Actions → New repository secret');
        console.log('  多個群組請以逗號分隔。');
      }
      console.log('─'.repeat(64));
    }
  });
});

server.listen(PORT, () => {
  console.log('\nLINE 群組 ID 接收器\n');
  console.log(`  監聽中：http://localhost:${PORT}/webhook`);
  console.log(`  簽章驗證：${SECRET ? '已啟用' : '未啟用（可設定 LINE_CHANNEL_SECRET 開啟）'}`);
  console.log('');
  console.log('  請依序完成：');
  console.log(`    1. 讓這個連接埠可從外部連入，例如：`);
  console.log(`         cloudflared tunnel --url http://localhost:${PORT}`);
  console.log(`         ngrok http ${PORT}`);
  console.log('    2. 把取得的網址加上 /webhook，填入 LINE Developers 的 Webhook URL');
  console.log('       並開啟「Use webhook」');
  console.log('    3. 在群組裡隨便說一句話');
  console.log('');
  console.log('  取得 ID 後請把 Webhook URL 清空或關閉，並按 Ctrl+C 結束本程式。');
  console.log('  等待事件中…');
});

process.on('SIGINT', () => {
  console.log('\n\n  已結束。');
  if (found.size > 0) {
    console.log('  本次取得的 ID：');
    for (const [id, d] of found) console.log(`    ${d.label}　${id}`);
  }
  console.log('');
  process.exit(0);
});
