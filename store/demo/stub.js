// ストア用スクリーンショット撮影専用: 拡張機能 API (chrome.*) の最小スタブ。
// ビルド済みの content script / popup を通常の Web ページ上で動かすために使う。
// 本番の拡張機能には含まれない（scripts/store-shots.mjs からのみ利用）。

const params = new URLSearchParams(location.search);
export const lang = params.get('lang') || 'ja';

const messageListeners = [];
let messages = {};

export async function installChromeStub({ tabState } = {}) {
  messages = await (await fetch(`/public/_locales/${lang}/messages.json`)).json();
  document.documentElement.lang = lang;

  globalThis.chrome = {
    runtime: {
      id: 'store-screenshot-stub',
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    i18n: {
      getUILanguage: () => lang,
      getMessage: (key, subs) => {
        const msg = messages[key]?.message ?? '';
        const list = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
        return msg.replace(/\$(\d)/g, (_, n) => list[Number(n) - 1] ?? '');
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [{ id: 1, url: tabState?.url ?? 'https://example.com/' }],
      sendMessage: async () => tabState?.response ?? null,
    },
  };
}

// popup / background からのメッセージ送信を模擬する
export async function sendToContent(msg) {
  for (const fn of messageListeners) {
    const res = await fn(msg, {}, () => {});
    if (res !== undefined) return res;
  }
  return undefined;
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export const t = (key) => messages[key]?.message ?? key;
