import './style.css';

// キー型は messages.json から自動生成される union に合わせる
type I18nKey = Parameters<typeof browser.i18n.getMessage>[0];
const t = (key: I18nKey): string => browser.i18n.getMessage(key) || key;

// アラビア語などRTL言語ではポップアップ全体を右→左レイアウトに
if ((browser.i18n.getUILanguage?.() ?? 'en').toLowerCase().startsWith('ar')) {
  document.documentElement.dir = 'rtl';
}

interface LockerState {
  lockMode: boolean;
  selectors: string[];
  origin: string;
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab<T>(tabId: number, msg: unknown): Promise<T | null> {
  try {
    return (await browser.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    return null; // content script 未注入 (chrome:// 等)
  }
}

function el(html: string): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as HTMLElement;
}

async function render() {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const tab = await activeTab();
  const origin = (() => {
    try {
      return tab?.url ? new URL(tab.url).origin : '';
    } catch {
      return '';
    }
  })();

  const state =
    tab?.id != null ? await sendToTab<LockerState>(tab.id, { type: 'btn-locker:state' }) : null;

  app.innerHTML = '';
  app.appendChild(el(`<h1>🔒 btn-locker</h1>`));
  app.appendChild(el(`<p class="sub">${t('popupSubtitle')}</p>`));

  if (!tab?.id || !state) {
    app.appendChild(el(`<p class="warn">${t('unsupportedPage')}</p>`));
    return;
  }

  const toggleBtn = el(
    `<button class="toggle ${state.lockMode ? 'on' : ''}">${state.lockMode ? t('stopLockMode') : t('startLockMode')}</button>`,
  );
  toggleBtn.addEventListener('click', async () => {
    const res = await sendToTab<{ lockMode: boolean }>(tab.id!, { type: 'btn-locker:toggle' });
    if (res?.lockMode) {
      // ロックモード開始が確定 → ポップアップを閉じてすぐロックできるようにする
      window.close();
      return;
    }
    await render();
  });
  app.appendChild(toggleBtn);
  app.appendChild(el(`<p class="hint">${t('hintLine')}</p>`));

  const listTitle = el(
    `<h2>${t('locksTitle')} (${state.selectors.length})<br /><span class="origin">${origin}</span></h2>`,
  );
  app.appendChild(listTitle);

  if (state.selectors.length === 0) {
    app.appendChild(el(`<p class="empty">${t('emptyLocks')}</p>`));
  } else {
    const ul = el(`<ul class="locks"></ul>`);
    for (const sel of state.selectors) {
      const li = el(`<li><code></code><button></button></li>`);
      (li.querySelector('code') as HTMLElement).textContent = sel;
      const unlockBtn = li.querySelector('button')!;
      unlockBtn.textContent = t('unlock');
      unlockBtn.addEventListener('click', async () => {
        await sendToTab(tab.id!, { type: 'btn-locker:unlock', selector: sel });
        await render();
      });
      ul.appendChild(li);
    }
    app.appendChild(ul);

    const clearBtn = el(`<button class="clear"></button>`);
    clearBtn.textContent = t('clearAll');
    clearBtn.addEventListener('click', async () => {
      await sendToTab(tab.id!, { type: 'btn-locker:clear' });
      await render();
    });
    app.appendChild(clearBtn);
  }
}

render();
