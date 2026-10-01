export default defineBackground(() => {
  // ユーザーが chrome://extensions/shortcuts で割り当てたショートカットを
  // アクティブタブの content script へ中継する（既定キーは未設定）。
  // content script 側が `btn-locker:toggle` メッセージを受けてロックモードを切り替える。
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-lock-mode') return;
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id != null) {
        await browser.tabs.sendMessage(tab.id, { type: 'btn-locker:toggle' });
      }
    } catch {
      // content script が未注入のページ (chrome:// 等) では届かなくて正常
    }
  });
});
