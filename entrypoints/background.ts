export default defineBackground(() => {
  // Alt+H などのショートカットをアクティブタブの content script へ中継する。
  // content script 側が `btn-hunter:toggle` メッセージを受けてハンターモードを切り替える。
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-hunter') return;
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id != null) {
        await browser.tabs.sendMessage(tab.id, { type: 'btn-hunter:toggle' });
      }
    } catch {
      // content script が未注入のページ (chrome:// 等) では届かなくて正常
    }
  });
});
