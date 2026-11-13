# プライバシーポリシー / Privacy Policy

最終更新: 2026-11-13

## 日本語

URL Gate は、利用者のデータを収集しません。外部への通信も行いません。

- **端末の中に保存するもの**（`chrome.storage.local`）
  - 設定ページに書いた対象 URL と例外の行
  - Touch ID（WebAuthn）の登録で作られた公開鍵とクレデンシャル ID
- **一時的に使うもの**
  - 開こうとしている URL。対象 URL に当たるかどうかを、端末の中で判定するためだけに使います。保存も送信もしません。
  - タブごとの解除の期限と、本人確認用のチャレンジ（`chrome.storage.session`。ブラウザを閉じると消えます）
- **扱わないもの**
  - 指紋などの生体情報。本人確認は OS とブラウザが行い、この拡張には結果の署名だけが渡されます。
  - 閲覧履歴の記録、ページの内容、入力した内容
- 開発者を含め、第三者にデータを送信、販売、共有することはありません。解析やトラッキングの仕組みも入れていません。
- 拡張を削除すると、保存したデータはすべて消えます。

問い合わせは [GitHub の Issues](https://github.com/yuki777/url-gate/issues) へお願いします。

## English

URL Gate does not collect any user data and makes no network requests of its own.

- **Stored locally on your device** (`chrome.storage.local`)
  - The target URL and exception lines you write on the options page
  - The public key and credential ID created when you register Touch ID (WebAuthn)
- **Used transiently**
  - The URL being opened, only to decide on your device whether it matches a target URL. It is neither stored nor transmitted.
  - Per-tab unlock expiry and the verification challenge (`chrome.storage.session`, cleared when the browser closes)
- **Never handled**
  - Biometric data such as fingerprints. User verification is performed by the OS and the browser; the extension only receives a signed result.
  - Browsing history logs, page content, or anything you type
- No data is sent, sold, or shared with anyone, including the developer. There is no analytics or tracking.
- Removing the extension deletes all stored data.

For questions, please open an issue on [GitHub](https://github.com/yuki777/url-gate/issues).
