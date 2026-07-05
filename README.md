# auto-threads-post

Threads の複数アカウント投稿を、ブラウザUIから操作するツールです。

- アカウントはブラウザのテーブルUIで管理
- ローカルDB（SQLite: `data/accounts.db`）に保存
- ブラウザ画面で投稿本文と対象を指定
- 指定アカウント投稿 or 全アカウント投稿
- 全アカウント投稿では時間分散を指定可能
- Playwright でログインから投稿まで自動実行

## 1. セットアップ

```bash
npm install
npx playwright install chromium
```

## 2. アカウント設定（ブラウザ）

1. 起動後、画面上部の「アカウント管理」テーブルで行を追加
2. `enabled`, `label`, `username / ID`, `password` を入力
3. 「アカウントを保存」を押す

- 保存先は `data/accounts.db`
- `enabled=true` の行だけ投稿対象
- `label` はUIで選択する識別子
- 初回のみ `data/accounts.md` がある場合は自動でDBへ移行されます

## 3. 起動

```bash
npm start
```

以下を開きます。

- http://localhost:3000

## 4. 使い方

1. 投稿本文を入力
2. モード選択
   - 指定アカウントに投稿
   - 全アカウントに投稿（時間分散）
3. 必要に応じて分散時間（分）を設定
4. 「投稿を実行」をクリック

## 注意点

- Threads 側の画面変更により、セレクタが将来変わる可能性があります。
- 2FA や追加認証が要求される場合、自動ログインは失敗します。
- パスワードはローカルDBに保存されるため、ローカル運用前提です。
