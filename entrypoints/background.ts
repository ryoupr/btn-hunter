import { migrateV1 } from '../utils/storage';

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
  browser.runtime.onMessage.addListener((msg: unknown, sender) => {
    const m = msg as { type?: string };
    if (m?.type !== 'btn-locker:mode-exit') return;
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    browser.tabs
      .sendMessage(tabId, { type: 'btn-locker:set-lockmode', on: false })
      .catch(() => undefined);
  });
});
