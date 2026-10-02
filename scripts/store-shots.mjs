// Chrome Web Store 用のスクリーンショット (1280x800) とプロモーションタイル (440x280) を生成する。
//
// 使い方: npm run build && node scripts/store-shots.mjs [lang]   (lang 既定: ja)
// 出力:   store/<lang>/screenshot-1-aim.png ほか, store/<lang>/promo-small-440x280.png
//
// ビルド済みの content script / popup を store/demo/ のデモページ上で動かし、
// ヘッドレス Chrome の --screenshot で撮影する。拡張 API は store/demo/stub.js でスタブ化。
// 画像要件 ref: https://developer.chrome.com/docs/webstore/images

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, '.output', 'chrome-mv3');
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const lang = process.argv[2] ?? 'ja';
if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(lang)) throw new Error(`invalid lang: ${lang}`);
const OUT = path.join(ROOT, 'store', lang);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

// 撮影に必要なディレクトリだけを配信する最小の静的サーバー (127.0.0.1 限定)
const ALLOWED_DIRS = ['store/demo', 'public', '.output/chrome-mv3'].map((d) => path.join(ROOT, d) + path.sep);

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.resolve(ROOT, `.${pathname}`);
      if (!ALLOWED_DIRS.some((dir) => file.startsWith(dir))) throw new Error('not allowed');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })),
  );
}

// ヘッドレス Chrome は --screenshot 書き出し後もプロセスが残ることがあるため、
// 出力ファイルのサイズが安定した時点で明示的に終了させる。
async function waitForFile(file, timeoutMs = 30000) {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    const size = await stat(file).then((s) => s.size, () => -1);
    if (size > 0 && size === last) return;
    last = size;
  }
  throw new Error(`screenshot timed out: ${file}`);
}

async function shoot(url, out, [w, h]) {
  const profile = await mkdtemp(path.join(tmpdir(), 'btn-locker-shot-'));
  await rm(out, { force: true });
  let child;
  try {
    child = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--lang=${lang.replace('_', '-')}`,
      `--window-size=${w},${h}`,
      '--force-device-scale-factor=1',
      '--virtual-time-budget=1500',
      `--screenshot=${out}`,
      url,
    ], { stdio: 'ignore' });
    await waitForFile(out);
    console.log(`wrote ${path.relative(ROOT, out)}`);
  } finally {
    child?.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  }
}

async function main() {
  // popup.html からハッシュ付きの chunk / CSS 名を取得
  const popupHtml = await readFile(path.join(BUILD, 'popup.html'), 'utf8');
  const chunk = popupHtml.match(/src="\/(chunks\/popup-[^"]+\.js)"/)?.[1];
  const css = popupHtml.match(/href="\/(assets\/popup-[^"]+\.css)"/)?.[1];
  if (!chunk || !css) throw new Error('popup chunk/css not found. Run `npm run build` first.');

  await mkdir(OUT, { recursive: true });
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const q = (o) => new URLSearchParams(o).toString();
  try {
    const content = '/.output/chrome-mv3/content-scripts/content.js';
    const popup = `/store/demo/popup.html?${q({ lang, chunk: `/.output/chrome-mv3/${chunk}`, css: `/.output/chrome-mv3/${css}` })}`;
    const scenes = [
      ['aim', 'screenshot-1-aim.png'],
      ['locked', 'screenshot-2-locked.png'],
      ['modal', 'screenshot-3-confirm.png'],
    ];
    for (const [scene, file] of scenes) {
      await shoot(
        `${base}/store/demo/page.html?${q({ scene, lang, content, popup })}`,
        path.join(OUT, file),
        [1280, 800],
      );
    }
    await shoot(`${base}/store/demo/promo.html?${q({ lang })}`, path.join(OUT, 'promo-small-440x280.png'), [440, 280]);
  } finally {
    server.close();
  }
}

await main();
