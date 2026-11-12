# Touch ID Gate

指定した URL を開く前に、Touch ID を要求する Chrome 拡張です。

ブラウザを操作できる AI エージェントは、ログイン済みのセッションが残っていれば、管理画面や認可画面のボタンを押すだけで重要な操作ができてしまいます。この拡張は、対象 URL への遷移を中間ページに差し替え、人が Touch ID を通すまで先へ進めないようにします。

対象 URL は設定ページで自由に追加できます。AWS IAM Identity Center（旧 AWS SSO）向けの対象 URL は、プリセットとして最初から有効になっています。

## 動作

1. 対象 URL へ移動しようとしたタブを、拡張の中間ページに差し替えます。
2. 中間ページで WebAuthn（`userVerification: required`、端末内蔵の認証器のみ）を通すと、そのタブだけ 2 分間ブロックを外し、元の URL へ進みます。
3. 2 分たつか、タブを閉じると、再びブロックします。

差し替えとは別に、declarativeNetRequest（ブラウザ側で通信を止める拡張 API）のルールでも止めています。拡張の処理が間に合わなかった場合でも、Touch ID を通していないタブからは通信が出ません。

ツールバーの拡張のボタンを押すと、いま開いているタブが対象 URL なら Touch ID を求め、通ればそのタブを 2 分間解除します。

## 対象 URL の設定

拡張の「詳細」→「拡張機能のオプション」で、対象にする URL パターンを 1 行に 1 つ書き、「Touch ID で保存する」を押します。対象を外す操作にもなるので、保存にも Touch ID が必要です（先に Touch ID の登録が必要です）。

```
example.com/admin*
*.internal.example.com
https://app-*.example.com/settings
```

- スキーム（`https://`）は省けます。http と https の両方が対象になります。
- ホストの `*` はホスト名の一部に一致します。先頭の `*.` はサブドメインなしにも一致するので、`*.example.com` は `example.com` と `a.b.example.com` の両方に一致します。
- パスは前方一致です。パスの `*` は任意の文字列に一致します。パスを省くと、そのホストのすべてのページが対象です。
- ポートを書かなければ、どのポートでも一致します（`example.com:8443` のように書くと、そのポートだけになります）。既定のポート（`:443`、`:80`）は、ブラウザが URL から省くので、省いた URL にも一致します。
- URL の `#` 以降（フラグメント）は書けません。通信の URL に含まれず、ブロックルールで止められないためです。
- 日本語のドメインやパスも、そのまま書けます（ブラウザと同じ形に直してから比べます。`127.1` のような IPv4 の省略形も同様です）。
- 続けて書いた `*` は 1 つにまとめます。
- 対象 URL は AWS プリセットと合わせて 1,000 件までです（Chrome のブロックルールの上限）。

ここで追加した URL は、ページを開く操作（画面の遷移と iframe の読み込み）を止めます。ページ内のスクリプトから呼ぶ API の通信は止めません。

URL パターンの解釈は [config.js](config.js) の `patternToRegex` にあります。

## AWS IAM Identity Center のプリセット

設定ページの「AWS IAM Identity Center のプリセットを使う」で有効・無効を切り替えられます（初期状態は有効）。AWS access portal のセッションが残っていれば、`aws sso login` の認可画面で「Allow access」を押すだけで認証情報を取得できてしまうのを防ぎます。

リージョンとサブドメインは任意です。定義は [config.js](config.js) の `AWS_PRESET` にあります。

### 開く前に必ず Touch ID を求める URL

- `oidc.*.amazonaws.com/authorize*`（`aws sso login` の認可画面）
- `oidc.*.api.aws/authorize*`
- `device.sso.*.amazonaws.com/*`（デバイスコードの確認画面）

### AWS access portal

- `*.awsapps.com/start*`
- `*.portal.*.app.aws/*`
- `*.*.portal.amazonaws.com/*`

一覧画面（`/start/`、`/start/#/`、`/start/#/?tab=accounts`、`/start/#/?tab=applications`）だけは Touch ID なしで開けます。それ以外の画面（`/start/#/console` など）は Touch ID を求めます。URL の `#` 以降はネットワーク層に届かないため、ここは通信のブロックではなく、遷移の検知で判定しています。

### 認証情報を取り出す通信

- `portal.sso.*.amazonaws.com/federation/*`
- `portal.sso.*.api.aws/federation/*`
- `oidc.*.amazonaws.com/device_authorization/*`
- `oidc.*.api.aws/device_authorization/*`

access portal がコンソールのサインイン URL やアクセスキーを取り出すときの通信と、デバイスコードを承認するときの通信です。画面を移動せずに呼べるので、Touch ID を通したタブ以外では通信そのものを止めます。

一覧画面でアクセスキーを表示したいときは、ツールバーの拡張のボタンを押してそのタブを解除します。

## インストール

Chrome 122 以降（Chromium 系ブラウザ）と、Touch ID のある Mac が必要です。

1. このリポジトリを clone するか、zip で取得して展開します。
2. `chrome://extensions` を開き、「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」で、このフォルダを選びます。
4. 拡張の「詳細」→「拡張機能のオプション」を開き、「Touch ID を登録する」を押します。
5. 同じページで、対象にする URL パターンを書いて保存します（AWS のプリセットだけ使う場合は不要です）。

登録前に対象 URL を開いた場合は、中間ページに「Touch ID を登録して開く」が出ます。押すと登録し、続けて Touch ID で本人確認をして、そのまま元の URL へ進みます（Touch ID は登録と本人確認で 2 回求められます）。

登録時にパスワードマネージャー（1Password など）の保存ダイアログが出たら、閉じてください。パスキーの保存先には、ブラウザのプロファイル（この端末だけに保存される選択肢）を選びます。

## 防げないこと

この拡張は、ブラウザ上の操作に確認を 1 段はさむだけです。次の経路は防げません。

- 拡張の無効化や削除、別プロファイル、シークレットウィンドウ（拡張を許可していない場合）、別のブラウザ
- 解除してから 2 分以内の、同じタブでの操作。再ロックはブラウザのアラームで行うため、アラームが遅れると、その分だけ解除が長く残ります
- 設定ページで追加した URL への、ページ内スクリプトからの通信（止めるのはページを開く操作だけです）
- 1 つのページの中で画面が切り替わる（URL の `#` 以降や History API で変わる）サイトで、切り替わった直後の一瞬（差し替えは切り替えの検知後に行うため）
- AWS プリセットで、access portal の一覧画面に出る情報（アカウント名、アカウント ID、ロール名）の閲覧
- 開発者ツールなどで拡張のページを直接操作して、設定を書き換えること
- OS のユーザー確認で、Touch ID の代わりに Mac のログインパスワードを入力すること
- ブラウザ内蔵の AI アシスタントなど、拡張のルールを通らずにページを開く仕組み（未確認）
- ブラウザを使わない経路（すでに発行済みの認証情報やトークンの利用など）

確実に防ぐ必要がある場合は、対象サービス側の設定（セッション時間の短縮、MFA の要求、権限の絞り込み）と併用してください。AWS なら IAM Identity Center 側の設定です。

## 構成

| ファイル | 役割 |
|---|---|
| `manifest.json` | 拡張の定義。`key` は拡張 ID を固定するための公開鍵です |
| `config.js` | AWS プリセット、URL パターンの解釈、設定の読み書き、解除時間の定義 |
| `background.js` | ブロックルールの登録、中間ページへの差し替え、署名の検証、タブ単位の解除、設定の保存 |
| `webauthn.js` | Touch ID の登録、認証要求、署名の検証 |
| `gate.html` / `gate.js` | 中間ページ |
| `options.html` / `options.js` | 設定ページ（Touch ID の登録、対象 URL の設定） |

外部への通信はありません。登録した公開鍵とクレデンシャル ID、対象 URL の設定は `chrome.storage.local` に保存します。

## リリース

[tagpr](https://github.com/Songmu/tagpr) で行います。main に push されると、`manifest.json` の version と `CHANGELOG.md` を更新するリリース PR が作られます。そのリリース PR をマージすると、タグと GitHub Release が作られます。上げ幅は既定でパッチです。リリース PR に `tagpr:minor` / `tagpr:major` ラベルを付けるか、リリースに含まれる PR に `minor` / `major` ラベルを付けておくと変えられます。リリース PR の `manifest.json` の version を直接書き換えると、それが優先されます。

## ライセンス

[MIT](LICENSE)
