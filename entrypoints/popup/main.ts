import './style.css';
import {
  clearLocks,
  isPausedFor,
  mutateLocks,
  readLocks,
  readPause,
  setGlobalPaused,
  setSitePaused,
  type LockEntry,
} from '../../utils/storage';

// キー型は messages.json から自動生成される union に合わせる
type I18nKey = Parameters<typeof browser.i18n.getMessage>[0];
const t = (key: I18nKey): string => browser.i18n.getMessage(key) || key;

// アラビア語などRTL言語ではポップアップ全体を右→左レイアウトに
if ((browser.i18n.getUILanguage?.() ?? 'en').toLowerCase().startsWith('ar')) {
  document.documentElement.dir = 'rtl';
}

interface LockerState {
  lockMode: boolean;
  origin: string;
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// frameId 省略時はタブ内の全フレームへ届く。状態取得はトップフレーム(frameId 0)に問い合わせる
async function sendToTab<T>(tabId: number, msg: unknown, frameId?: number): Promise<T | null> {
  try {
    const res = await browser.tabs.sendMessage(
      tabId,
      msg,
      frameId === undefined ? undefined : { frameId },
    );
    return (res ?? null) as T | null;
  } catch {
    return null; // content script 未注入 (chrome:// 等)
  }
}

// i18n 文言のみを含む静的な HTML 用 (ユーザーデータは必ず textContent で入れる)
function el(html: string): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as HTMLElement;
}

function toggleRow(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el(`<label class="switch"><input type="checkbox" role="switch" /><span></span></label>`);
  const input = row.querySelector('input') as HTMLInputElement;
  (row.querySelector('span') as HTMLElement).textContent = label;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return row;
}

async function render() {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const tab = await activeTab();

  const state =
    tab?.id != null
      ? await sendToTab<LockerState>(tab.id, { type: 'btn-locker:state' }, 0)
      : null;

  app.innerHTML = '';
  document.body.classList.remove('paused');
  app.appendChild(el(`<h1>🔒 btn-locker</h1>`));
  app.appendChild(el(`<p class="sub">${t('popupSubtitle')}</p>`));

  if (!tab?.id || !state) {
    app.appendChild(el(`<p class="warn">${t('unsupportedPage')}</p>`));
    appendFooter(app);
    return;
  }
  const tabId = tab.id;
  const topOrigin = state.origin;

  const [db, pause] = await Promise.all([readLocks(), readPause()]);
  const entries: LockEntry[] = db[topOrigin] ?? [];
  const paused = isPausedFor(pause, topOrigin);
  if (paused) document.body.classList.add('paused');

  if (paused) {
    const banner = el(`<p class="banner" role="status"></p>`);
    banner.textContent = pause.global ? t('pausedAllBanner') : t('pausedSiteBanner');
    app.appendChild(banner);
  }

  const toggleBtn = el(
    `<button class="toggle ${state.lockMode ? 'on' : ''}">${state.lockMode ? t('stopLockMode') : t('startLockMode')}</button>`,
  ) as HTMLButtonElement;
  toggleBtn.disabled = paused;
  toggleBtn.addEventListener('click', async () => {
    // ロックモードはタブ内の全フレームで同期させる: 反転後の値を全フレームへ配る
    const on = !state.lockMode;
    await sendToTab(tabId, { type: 'btn-locker:set-lockmode', on });
    if (on) {
      // ロックモード開始が確定 → ポップアップを閉じてすぐロックできるようにする
      window.close();
      return;
    }
    await render();
  });
  app.appendChild(toggleBtn);
  app.appendChild(el(`<p class="hint">${t('hintLine')}</p>`));

  // 一時停止 (このサイトだけ / 全体)
  const pauseBox = el(`<div class="pause"><h2></h2></div>`);
  (pauseBox.querySelector('h2') as HTMLElement).textContent = t('pauseTitle');
  pauseBox.appendChild(
    toggleRow(t('pauseSite'), pause.sites.includes(topOrigin), async (v) => {
      await setSitePaused(topOrigin, v);
      await render();
    }),
  );
  pauseBox.appendChild(
    toggleRow(t('pauseAll'), pause.global, async (v) => {
      await setGlobalPaused(v);
      await render();
    }),
  );
  app.appendChild(pauseBox);

  const listTitle = el(`<h2><span class="count"></span><br /><span class="origin"></span></h2>`);
  (listTitle.querySelector('.count') as HTMLElement).textContent =
    `${t('locksTitle')} (${entries.length})`;
  (listTitle.querySelector('.origin') as HTMLElement).textContent = topOrigin;
  app.appendChild(listTitle);

  if (entries.length === 0) {
    app.appendChild(el(`<p class="empty">${t('emptyLocks')}</p>`));
  } else {
    const ul = el(`<ul class="locks"></ul>`);
    for (const entry of entries) {
      const li = el(
        `<li><div class="info"><span class="name" dir="auto"></span><code></code><span class="frame"></span></div><button></button></li>`,
      );
      // ボタン名を主表示、セレクタは小さく補足 (v1 から移行した n='' はセレクタのみ)
      (li.querySelector('.name') as HTMLElement).textContent = entry.n || entry.s;
      const code = li.querySelector('code') as HTMLElement;
      if (entry.n) code.textContent = entry.s;
      else code.remove();
      const frame = li.querySelector('.frame') as HTMLElement;
      if (entry.f !== topOrigin) frame.textContent = `iframe: ${entry.f}`;
      else frame.remove();
      const unlockBtn = li.querySelector('button')!;
      unlockBtn.textContent = t('unlock');
      unlockBtn.addEventListener('click', async () => {
        await mutateLocks(topOrigin, entry.f, { remove: [entry.s] });
        await sendToTab(tabId, { type: 'btn-locker:reload' });
        await render();
      });
      ul.appendChild(li);
    }
    app.appendChild(ul);

    // 「すべて解除」は二段階: 1回目で確認状態、2回目で実行、3秒で元に戻る (confirm() は使わない)
    const clearBtn = el(`<button class="clear"></button>`) as HTMLButtonElement;
    clearBtn.textContent = t('clearAll');
    let armed = false;
    let timer: number | undefined;
    clearBtn.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        clearBtn.textContent = t('clearAllConfirm');
        clearBtn.classList.add('danger');
        timer = window.setTimeout(() => {
          armed = false;
          clearBtn.textContent = t('clearAll');
          clearBtn.classList.remove('danger');
        }, 3000);
        return;
      }
      window.clearTimeout(timer);
      await clearLocks(topOrigin);
      await sendToTab(tabId, { type: 'btn-locker:reload' });
      await render();
    });
    app.appendChild(clearBtn);
  }
  appendFooter(app);
}

function appendFooter(app: HTMLElement) {
  const btn = el(`<button class="options-link"></button>`);
  btn.textContent = t('openOptions');
  btn.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });
  app.appendChild(btn);
}

render();
