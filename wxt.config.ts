import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
// UI文言は public/_locales/*/messages.json で9言語対応 (chrome.i18n)
// ref: https://wxt.dev/guide/essentials/i18n
export default defineConfig({
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: ['storage', 'activeTab'],
    commands: {
      'toggle-hunter': {
        // Chrome Manifest V3 の commands 形式
        // ref: https://developer.chrome.com/docs/extensions/reference/api/commands
        suggested_key: {
          default: 'Alt+H',
        },
        description: '__MSG_commandToggle__',
      },
    },
    action: {
      default_title: '__MSG_actionTitle__',
    },
  },
});
