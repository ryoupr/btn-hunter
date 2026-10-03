# Contributing to btn-locker

btn-locker へのコントリビューションありがとうございます。このドキュメントは開発フローとリリース仕様の概要です。

## ブランチ運用

- 作業は Feature ブランチで行い、`develop` へ Pull Request を作成してください。
- `develop` → `main` の Pull Request はリリース専用です（`version` bump はここでのみ行う）。
- `main` / `develop` への直接 push は行わないでください。
- 1つの Pull Request では1つの目的に絞ってください。

## 開発手順

```bash
npm install

# 開発モード（HMR付き）
npm run dev

# 型チェック
npm run compile

# Chrome Web Store 用 ZIP 作成
npm run zip
```

コマンドの詳細は [README.md](README.md) の `## 開発コマンド` を参照してください。

## Pull Request とレビュー

- すべての変更はレビューを必須とします。セルフマージは行わないでください。
- Pull Request には変更内容と動作確認の結果を記載してください。

## リリース手順

1. `develop` から `main` へのリリース用 Pull Request を作成し、その中で `package.json` の `version` を上げて `main` にマージします。
2. `main` へのマージ後、CI（`.github/workflows/release.yml`）が自動でビルド→GitHub Release 作成→Chrome Web Store への提出申請を行います。
3. ストア審査中（`PENDING_REVIEW`）は `develop` → `main` の Pull Request をマージしないでください（`store-review-guard` が自動でブロックします）。

Chrome Web Store API は既存アイテムの更新のみを行います。ストアへの初回公開は Developer Dashboard から手動で行ってください（手順は [README.md](README.md) の `## Chrome Web Store 公開手順`）。

## CI の起動条件

CI の定義は [.github/workflows/ci.yml](.github/workflows/ci.yml) と [.github/workflows/release.yml](.github/workflows/release.yml) を正とします。概要は以下の通りです。

- `ci.yml`: `develop` / `main` への Pull Request と `develop` への push でビルド検証（`npm ci` → `npm run compile` → `npm run zip`）のみ行います。リリースは行いません。
- `ci.yml` の `store-review-guard`: `main` への Pull Request 時のみ実行し、ストア審査中（`PENDING_REVIEW`）の場合は失敗させてマージをブロックします。
- `release.yml`: `main` ブランチへの push のうち、`package.json` または `wxt.config.ts` の変更を含む場合のみ起動します。
  - `package.json` の `version` に対応するタグ（`v{version}`）が既に存在する場合は、ビルド・Release 作成・ストア提出のすべてをスキップします。
  - Chrome Web Store への提出は審査状態を確認し、審査中（`PENDING_REVIEW`）の場合は提出のみスキップします（GitHub Release の作成は継続します）。

## 必要な Secrets（名前のみ）

ストア提出に必要な Secrets の名前は以下の通りです。値や ID の実値は記載・共有しないでください。

| Secret 名 | 用途 |
|-----------|------|
| `CWS_SERVICE_ACCOUNT_JSON` | Chrome Web Store API（v2）用サービスアカウントキー |
| `CHROME_PUBLISHER_ID` | Chrome Web Store のパブリッシャー ID |
| `CHROME_EXTENSION_ID` | Chrome Web Store の拡張機能 ID |

- `CWS_SERVICE_ACCOUNT_JSON` が未設定の場合は、ストア提出のステップのみスキップされます（GitHub Release の作成は行われます）。
- `store-review-guard` は Secrets が揃っていない場合、判定せずに通過します（fail-open）。
