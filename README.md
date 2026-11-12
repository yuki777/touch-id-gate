# SSO Touch ID Gate

AWS IAM Identity Center（旧 AWS SSO）のサインイン関連 URL を開く前に、Touch ID を要求する Chrome 拡張です。

ブラウザを操作できる AI エージェントは、AWS access portal のセッションが残っていれば、`aws sso login` の認可画面で「Allow access」を押すだけで認証情報を取得できます。この拡張は、対象 URL への遷移を中間ページに差し替え、人が Touch ID を通すまで先へ進めないようにします。

## 動作

1. 対象 URL を、declarativeNetRequest（ブラウザ側で通信を止める拡張 API）のルールで常にブロックします。
2. 対象 URL へ移動しようとしたタブを、拡張の中間ページに差し替えます。
3. 中間ページで WebAuthn（`userVerification: required`、端末内蔵の認証器のみ）を通すと、そのタブだけ 2 分間ブロックを外し、元の URL へ進みます。
4. 2 分たつか、タブを閉じると、再びブロックします。

## 対象 URL

リージョンとサブドメインは任意です。定義は [config.js](config.js) にあります。

- `*.awsapps.com/start*`
- `*.portal.*.app.aws/*`
- `*.*.portal.amazonaws.com/*`
- `oidc.*.amazonaws.com/authorize*`
- `oidc.*.api.aws/authorize*`
- `device.sso.*.amazonaws.com/*`

URL の `#` 以降はネットワーク層に届かないため、access portal は `/start` 配下をまるごと対象にしています。

## インストール

Chrome 122 以降（Chromium 系ブラウザ）と、Touch ID のある Mac が必要です。

1. このリポジトリを clone するか、zip で取得して展開します。
2. `chrome://extensions` を開き、「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」で、このフォルダを選びます。
4. 拡張の「詳細」→「拡張機能のオプション」を開き、「Touch ID を登録する」を押します。

登録時にパスワードマネージャー（1Password など）の保存ダイアログが出たら、閉じてください。パスキーの保存先には、ブラウザのプロファイル（この端末だけに保存される選択肢）を選びます。

## 防げないこと

この拡張は、ブラウザ上の操作に確認を 1 段はさむだけです。次の経路は防げません。

- 拡張の無効化や削除、別プロファイル、シークレットウィンドウ（拡張を許可していない場合）、別のブラウザ
- 解除してから 2 分以内の、同じタブでの操作
- すでに開いている access portal のタブでの操作
- OS のユーザー確認で、Touch ID の代わりに Mac のログインパスワードを入力すること
- ブラウザ内蔵の AI アシスタントなど、拡張のルールを通らずにページを開く仕組み（未確認）
- ブラウザを使わない経路（すでに発行済みの認証情報やトークンの利用など）

確実に防ぐ必要がある場合は、IAM Identity Center 側の設定（セッション時間の短縮、MFA の要求、割り当てる権限の絞り込み）と併用してください。

## 構成

| ファイル | 役割 |
|---|---|
| `manifest.json` | 拡張の定義。`key` は拡張 ID を固定するための公開鍵です |
| `config.js` | 対象 URL と解除時間の定義 |
| `background.js` | ブロックルールの登録、中間ページへの差し替え、署名の検証、タブ単位の解除 |
| `webauthn.js` | Touch ID の登録、認証要求、署名の検証 |
| `gate.html` / `gate.js` | 中間ページ |
| `options.html` / `options.js` | 設定ページ（Touch ID の登録） |

外部への通信はありません。登録した公開鍵とクレデンシャル ID は `chrome.storage.local` に保存します。

## ライセンス

[MIT](LICENSE)
