# 🔒 btn-locker — ボタンロッカー

「うっかり押し」や「事故タップ」を防ぐための、ボタン誤爆防止セーフティ Chrome 拡張機能。

ページ上の危険なボタンをロックすると、通常の 1 クリックでは発火しなくなります。
本当に押したいときはダブルクリック → 確認モーダルで承認 → 本来のクリック処理が実行されます。

## 機能

- **🔒 ロックモード**: 拡張ボタン or ショートカットキーで起動。カーソルが南京錠に変わり、ホバー中のボタンが赤枠で強調表示されます
- **🛡️ ロック**: 狙ったボタンをクリックするだけでロック。グレーアウト＋🔒バッジ表示になり、シングルクリックは無効化されます
- **⚠️ 二段階解除**: ロック中のボタンをダブルクリックすると確認モーダル（Shadow DOM でページ CSS と隔離）が出現。「今回だけ実行する」でのみ本来の処理が発火します
- **💾 永続化**: ロック情報は `chrome.storage.local` に「トップページのオリジン」単位で保存（キー `btn-locker:locks:v2`）。リロード後も維持されます。ボタン名（最大 40 文字）も保存し、ポップアップの一覧ではボタン名を主表示、セレクタを補足表示します
- **🔄 SPA 対応**: ロックが 1 件以上あるときだけ `MutationObserver` を動かし、後から生成されたボタンにもロックを自動再適用（0 件になったら停止）。`document_start` 起動で読み込み直後の素通しウィンドウを最小化しています
- **🧱 すり抜け防止**: ロック中のボタンは `click` だけでなく `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `touchstart` / `touchend` も capture フェーズで止めます。ロックモード中の狙い先も同様です。「今回だけ実行する」では pointer / mouse / click を一連で再発火します
- **🪟 iframe 対応**: `allFrames` で iframe 内のボタンもロックできます。保存キーはトップページのオリジン、各エントリにはフレームのオリジンを持ち、自フレームのエントリだけを適用します。ロックモードはタブ内の全フレームで同期します
- **🫧 Shadow DOM 対応**: open な shadow root 内のボタンもロックできます。セレクタは独自形式 `ホストのセレクタ >>> 内部のセレクタ`（入れ子可）で保存し、リロード後も再解決します
- **🎯 クリック可能要素の判定**: `button` / `a` / `input[type=button|submit|image|reset]` / `summary` / `[role=button|link|menuitem]` / `[onclick]`
- **🧭 セレクタの安定化**: 安定した `id`（自動生成らしいものは除外）→ `data-testid` / `data-test` / `data-qa` → `name` → `aria-label` → 構造ベースの順で、一意に決まる最短のものを採用。自己修復時は、一致しなくなった古いセレクタを置き換えてデータを溜めません
- **⏸ 一時停止**: 「このサイトだけ」「全体」の 2 種類。一時停止中はロックの見た目を外し、クリックも阻止しません（ロックの定義は保持）。ポップアップに警告バナーを表示します
- **📦 エクスポート / インポート**: オプションページでロックと一時停止設定を JSON で書き出し・読み込み（マージ / 置換を選択）。読み込み時はスキーマを厳密に検証し、不正なファイルはエラー表示にします。`downloads` 権限は使いません（Blob + `a[download]`）
- **♿ 確認モーダルのアクセシビリティ**: `role="dialog"` / `aria-modal` / `aria-labelledby`、初期フォーカスは「キャンセル」、Esc で閉じる、Tab はモーダル内に閉じ込め、閉じたら元の要素へフォーカスを戻します
- **🚪 モード終了**: ショートカットキー / 右クリック / `Esc` のいずれかでロックモードを終了できます
- **⌨️ ショートカット**: 既定キーは未設定です。`chrome://extensions/shortcuts` で「ロックモードの ON/OFF 切り替え」に好きなキーを割り当ててください（[commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)）

## 対応言語（9 言語）

UI はブラウザの表示言語に自動追従します（`chrome.i18n`＋`public/_locales` 方式、デフォルト英語）。

英語 / 中国語（簡体字）/ スペイン語 / ヒンディー語 / アラビア語（RTL 対応）/ ポルトガル語（ブラジル）/ ロシア語 / ベンガル語 / 日本語

言語の追加は `public/_locales/<ロケール>/messages.json` を 1 ファイル足すだけです（キーは英語版に合わせること）。

## 使い方

1. ツールバーの 🔒 ボタンを押す（またはショートカットキー）→ ロックモード開始（ポップアップは自動で閉じます）
2. 南京錠カーソルで狙い、ブロックしたいボタンをクリック → ロック完了（グレーアウト＋🔒）
3. ロック中のボタンのシングルクリックは何も起きません（トーストで通知）
4. 本当に押したいときはダブルクリック → 確認モーダル →「今回だけ実行する」
5. ロックを外すときはモーダルの「ロック解除」か、ポップアップの一覧から解除（「すべて解除」は 2 回押しで実行。3 秒で元に戻ります）
6. 一時的にロックを無効にしたいときは、ポップアップの「このサイトだけ一時停止」または「すべてのサイトで一時停止」をオン
7. 別のブラウザや端末へ移すときは、ポップアップ下部の「エクスポート / インポート設定」（オプションページ）から JSON で書き出し・読み込み

### エクスポート JSON の形式

```json
{
  "app": "btn-locker",
  "format": 1,
  "locks": { "https://example.com": [{ "s": "#send", "f": "https://example.com", "n": "Send" }] },
  "pause": { "global": false, "sites": [] }
}
```

`s` = セレクタ（Shadow DOM 内は `ホスト >>> 内部`）、`f` = フレームのオリジン、`n` = ボタン名。インポート時の上限: セレクタ 500 文字、ボタン名 40 文字、1 オリジン 500 件、合計 5000 件、ファイル 1MB。

### 旧バージョンからの移行

v0.1.x の保存データ（`btn-locker:locks:v1`）は、拡張の起動時に自動で v2 形式へ変換され、v1 は削除されます（冪等）。


## インストール（開発者モード）

```bash
npm install
npm run build
```

1. `chrome://extensions` を開き、デベロッパーモードを ON
2. 「パッケージ化されていない拡張機能を読み込む」→ `.output/chrome-mv3` を選択

開発中は `npm run dev` で HMR 付きの開発用 Chrome が起動します。

## 開発コマンド

| コマンド          | 内容                                   |
| ----------------- | -------------------------------------- |
| `npm run dev`     | HMR 付き開発サーバー＋開発用 Chrome 起動 |
| `npm run compile` | TypeScript 型チェック（`tsc --noEmit`） |
| `npm run build`   | プロダクションビルド（`.output/chrome-mv3`） |
| `npm run zip`     | ストア提出用 ZIP を生成                 |
| `npm run store:shots` | ストア用スクリーンショット・プロモーションタイルを `store/ja`・`store/en` に生成（要 Google Chrome。macOS 以外は `CHROME_PATH` で実行ファイルを指定） |
| `python3 scripts/gen-icons.py` | 南京錠アイコン（`public/icon/*.png`）を再生成（要 Pillow） |

技術スタック: [WXT](https://wxt.dev)（vanilla-ts テンプレート）/ TypeScript / Manifest V3

### ブランチ運用

- `feature/*` → `develop`: PR で結合・ビルド検証（`ci.yml` のみ、リリースなし）
- `develop` → `main`: リリースPR（version bump はここでのみ行う）
- `main` push: `release.yml` がビルド→GitHub Release→ストア提出を行う
- `develop` → `main` のPRはストア審査中（`PENDING_REVIEW`）はマージ不可（`store-review-guard` がブロック）

詳細は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## プロジェクト構成

```
entrypoints/
├── content.ts   # ロック・確認モーダル・イベント阻止のコアロジック (全フレームで動作)
├── background.ts# ショートカットキー、iframe からのロックモード終了の中継、v1→v2 移行
├── popup/       # ON/OFF トグル・一時停止・ロック一覧 UI
└── options/     # エクスポート / インポート (options_ui)
utils/
├── storage.ts   # ストレージの読み書き・移行 (content / popup / options / background で共有)
├── selector.ts  # セレクタ生成と ">>>" パスの解決 (Shadow DOM 対応)
└── validate.ts  # インポート JSON のスキーマ検証
public/icon/    # 拡張アイコン (16/32/48/96/128px)
scripts/        # アイコン・ストア画像の生成スクリプト
store/          # ストア掲載画像 (ja/en) と撮影用デモページ (demo/)
wxt.config.ts   # 拡張名・権限・ショートカット定義
```

## 権限の説明（ストア審査向け）

| 権限 / 対象 | 用途 |
| ----------- | ---- |
| `storage` | ロックしたボタンのセレクタ・ボタン名・一時停止設定を端末内に保存するため |
| `activeTab` | ポップアップ→content script へのメッセージ送信と、表示中サイトのオリジン表示のため（クリック時のみ） |
| content scripts `<all_urls>`（`all_frames`） | 任意の Web ページ（iframe 内を含む）上でボタンをロックできるようにするため |

- リモートコード・外部送信は一切ありません（全コードをバンドル）。
- 収集するユーザーデータはありません。ロック情報（セレクタ・ボタン名・オリジン）と一時停止設定は端末内の `chrome.storage.local` にのみ保存されます。
- エクスポートはユーザー操作でローカルファイルに書き出すだけで、外部へは送信しません（`downloads` 権限も不要）。

## Chrome Web Store 公開手順

1. `npm run zip` で提出用 ZIP（`.output/*.zip`）を生成
2. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) で「新しいアイテム」→ ZIP をアップロード（初回は $5 の登録料が必要）
3. ストア掲載情報・プライバシー（単一用途・権限の理由・リモートコード・データ使用）を入力 → 送信（審査は通常 1〜3 営業日）

上記は初回公開の手順です。公開後のアップデートは、`develop` → `main` のリリースPRで `package.json` の `version` を上げてマージすると、`release.yml` が GitHub Release の作成と Chrome Web Store への提出を自動で行います（要 Secrets。[CONTRIBUTING.md](CONTRIBUTING.md) 参照）。

### リスティング文案（ドラフト）

- **簡潔な説明（132 文字以内）**: 押し間違い・誤タップを防ぐ！危険なボタンをロックし、ダブルクリック＋確認でのみ実行できるセーフティ拡張。
- **詳細な説明**: btn-locker（ボタンロッカー）は、Web ページ上の「絶対に押し間違えたくないボタン」をロックできる拡張機能です。
  - ワンクリックの事故（誤送信・誤削除・誤購入など）を二段階操作で防止
  - ロックはドメインごとに記憶され、リロード後も維持
  - 確認モーダルでの「今回だけ実行」「ロック解除」に対応
  - データの外部送信なし・安心設計
- **単一用途の説明**: Web ページ上のボタンをロックし、誤クリックによる意図しない操作を防ぐ。
- **カテゴリ**: 生産性
- **言語**: 日本語

### 必要なアセット

参照: https://developer.chrome.com/docs/webstore/images

- [x] アイコン 128px（`public/icon/128.png` 同梱。16/32/48/96px もあり）
- [x] スクリーンショット 1280x800 × 3 枚（`store/ja/screenshot-*.png`、英語版は `store/en/`）
- [x] プロモーションタイル small 440x280（`store/ja/promo-small-440x280.png`、英語版は `store/en/`）
- [ ] プライバシーポリシー URL（データ収集なしだが、求められた場合は下記ドラフトを GitHub Pages 等でホスト）

スクリーンショットはビルド済みの content script / popup をデモページ（`store/demo/`）上で動かして撮影した実際の UI です。ヘッドレス撮影ではマウスカーソルが写らないため、1 枚目のみ実際のカーソル画像を同じ位置に重ねています。

### プライバシーポリシー（ドラフト）

> btn-locker は、ユーザーの個人情報や閲覧データを収集・送信・共有しません。ロックしたボタンの情報（CSS セレクタ、ボタンの表示名、ロックしたページ/フレームのオリジン）と一時停止の設定は、利用者の端末内のブラウザストレージ（chrome.storage.local）にのみ保存され、外部サーバーへの送信は行いません。設定のエクスポートは、利用者の操作によりローカルファイルへ保存されるだけです。

## 既知の制限

- ページ読み込み直後の数十 ms（ストレージ読み込み中）はロック未適用の瞬間があります（`document_start` 起動で最小化済み）
- closed な Shadow DOM 内のボタンは、ページ側から辿れないため対象外です（open のみ対応）。Shadow DOM 内の `MutationObserver` は、ロック済みパスで辿れた open shadow root のみ監視します
- iframe: `about:blank` / `srcdoc` / `data:` の iframe は対象外です（`matchAboutBlank` 未使用）。iframe 内でロックしたセレクタは、トップページと同一オリジンの iframe では、トップ側の同じセレクタにも一致する要素があれば同様にロックされます。ロックモードは、ONにした後に読み込まれた iframe には引き継がれません
- `about:blank` / `srcdoc` / `blob:` の iframe は対象外です
- Chrome 専用です（トップページのオリジンの特定に `location.ancestorOrigins` を使うため。Firefox 等では iframe 内の保存キーがずれる場合があります）
- ストレージへの書き込みは background に集約し、Web Locks で直列化しています（複数タブ/フレームの同時ロックでも取りこぼしません）
- `chrome://` 配下や Chrome ウェブストアのページでは動作しません（Chrome の仕様）

## ライセンス

MIT License（`LICENSE` 参照）。
