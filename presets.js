// 設定ページのボタンで、対象 URL の欄に追加できる例。
// ここにあるのは設定ページに書けるのと同じ行だけで、特定のサービス向けの処理は持たない。

// AWS access portal の一覧画面。ここだけは Touch ID なしで開けるようにする。
const AWS_PORTAL_LIST_FRAGMENTS = ['', '#/', '#/?tab=accounts', '#/?tab=applications'];
const awsPortalListScreens = (host, paths) =>
  paths.flatMap((path) => AWS_PORTAL_LIST_FRAGMENTS.map((fragment) => `!${host}${path}${fragment}`));

// AWS IAM Identity Center（旧 AWS SSO）。リージョンとサブドメインは任意。
export const AWS_IAM_IDENTITY_CENTER = {
  name: 'AWS IAM Identity Center',
  lines: [
    '# AWS IAM Identity Center: aws sso login の認可画面と、デバイスコードの確認画面',
    'oidc.*.amazonaws.com/authorize',
    'oidc.*.api.aws/authorize',
    'device.sso.*.amazonaws.com',
    '',
    '# AWS access portal。一覧画面（! の行）だけは Touch ID なしで開ける',
    '*.awsapps.com/start',
    ...awsPortalListScreens('*.awsapps.com', ['/start', '/start/']),
    '*.portal.*.app.aws',
    ...awsPortalListScreens('*.portal.*.app.aws', ['/', '/start', '/start/']),
    '*.*.portal.amazonaws.com',
    ...awsPortalListScreens('*.*.portal.amazonaws.com', ['/', '/start', '/start/']),
    '',
    '# 認証情報を取り出す通信と、デバイスコードを承認する通信。画面を移動せずに呼べるので、通信も止める',
    'all:portal.sso.*.amazonaws.com/federation/',
    'all:portal.sso.*.api.aws/federation/',
    'all:oidc.*.amazonaws.com/device_authorization/',
    'all:oidc.*.api.aws/device_authorization/',
  ],
};

export const PRESETS = [AWS_IAM_IDENTITY_CENTER];
