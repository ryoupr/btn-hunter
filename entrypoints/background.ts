import { LIMITS, migrateV1, mutateLocks, type LockEntry } from '../utils/storage';

export default defineBackground(() => {
  // v1 → v2 の保存形式移行 (冪等)。インストール/更新時と、サービスワーカー起動時の両方で試みる
  browser.runtime.onInstalled.addListener(() => {
    void migrateV1().catch(() => undefined);
  });
  void migrateV1().catch(() => undefined);

  // ユーザーが chrome://extensions/shortcuts で割り当てたショートカットを処理する（既定キーは未設定）。
  // トップフレームのロックモード状態を問い合わせ、反転した値をタブ内の全フレームへ配る。
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-lock-mode') return;
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) return;
      const state = (await browser.tabs.sendMessage(
        tab.id,
        { type: 'btn-locker:state' },
        { frameId: 0 },
      )) as { lockMode?: boolean } | undefined;
      await browser.tabs.sendMessage(tab.id, {
        type: 'btn-locker:set-lockmode',
        on: !state?.lockMode,
      });
    } catch {
      // content script が未注入のページ (chrome:// 等) では届かなくて正常
    }
  });

  // iframe 内で Esc / 右クリックによりロックモードが終了したとき、同じタブの全フレームを OFF にそろえる。
  // 応答は返さない (sendResponse 方式のメッセージング。Promise は返さない)。
  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    const m = msg as {
      type?: string;
      top?: unknown;
      f?: unknown;
      add?: unknown;
      remove?: unknown;
    };
    // content script からの書き込みはここに集約する (Web Locks は content script と
    // 拡張機能のオリジン間で共有されないため、background で直列化する)
    if (m?.type === 'btn-locker:mutate') {
      if (typeof m.top !== 'string' || typeof m.f !== 'string') return;
      const add: LockEntry[] = (Array.isArray(m.add) ? m.add : [])
        .filter(
          (e): e is LockEntry =>
            typeof e === 'object' &&
            e !== null &&
            typeof (e as LockEntry).s === 'string' &&
            (e as LockEntry).s.length > 0 &&
            (e as LockEntry).s.length <= LIMITS.maxSelector &&
            typeof (e as LockEntry).f === 'string' &&
            typeof (e as LockEntry).n === 'string',
        )
        .map((e) => ({ s: e.s, f: e.f, n: e.n.slice(0, LIMITS.maxName) }));
      const remove = (Array.isArray(m.remove) ? m.remove : []).filter(
        (x): x is string => typeof x === 'string',
      );
      mutateLocks(m.top, m.f, { add, remove }).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true; // 非同期で sendResponse するため (Promise は返さない)
    }
    if (m?.type !== 'btn-locker:mode-exit') return;
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    browser.tabs
      .sendMessage(tabId, { type: 'btn-locker:set-lockmode', on: false })
      .catch(() => undefined);
  });
});
