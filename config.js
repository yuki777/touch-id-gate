const SUBDOMAINS = '([a-z0-9-]+\\.)*';
const REGION = '[a-z0-9-]+';

// pattern は RE2（ブロックルール用）と JavaScript の両方で通る書き方にする。リージョンとサブドメインは任意。

// 開く前に必ず Touch ID を求める URL。
export const GATED_NAVIGATIONS = [
  { label: 'oidc.*.amazonaws.com/authorize*', pattern: `^https?://oidc\\.${REGION}\\.amazonaws\\.com/authorize` },
  { label: 'oidc.*.api.aws/authorize*', pattern: `^https?://oidc\\.${REGION}\\.api\\.aws/authorize` },
  { label: 'device.sso.*.amazonaws.com/*', pattern: `^https?://device\\.sso\\.${REGION}\\.amazonaws\\.com/` },
];

// AWS access portal。一覧画面だけは Touch ID なしで開け、それ以外の画面は Touch ID を求める。
// URL の # 以降はネットワーク層に届かないので、ここはブロックルールではなく遷移の検知で判定する。
export const PORTAL_SITES = [
  { label: '*.awsapps.com/start*', pattern: `^https?://${SUBDOMAINS}awsapps\\.com/start` },
  { label: '*.portal.*.app.aws/*', pattern: `^https?://${SUBDOMAINS}portal\\.${REGION}\\.app\\.aws/` },
  { label: '*.*.portal.amazonaws.com/*', pattern: `^https?://${SUBDOMAINS}${REGION}\\.portal\\.amazonaws\\.com/` },
];

// ポータルが認証情報を取り出す通信（コンソールのサインイン URL、アクセスキー）と、
// デバイスコードを承認する通信。画面を移動せずに呼べるので、Touch ID を通したタブ以外ではネットワーク層で止める。
export const CREDENTIAL_REQUESTS = [
  {
    label: 'portal.sso.*.amazonaws.com/federation/*',
    pattern: `^https?://portal\\.sso\\.${REGION}\\.amazonaws\\.com/federation/`,
  },
  { label: 'portal.sso.*.api.aws/federation/*', pattern: `^https?://portal\\.sso\\.${REGION}\\.api\\.aws/federation/` },
  {
    label: 'oidc.*.amazonaws.com/device_authorization/*',
    pattern: `^https?://oidc\\.${REGION}\\.amazonaws\\.com/device_authorization/`,
  },
  {
    label: 'oidc.*.api.aws/device_authorization/*',
    pattern: `^https?://oidc\\.${REGION}\\.api\\.aws/device_authorization/`,
  },
];

// Touch ID なしで開けるポータルの画面（一覧）。ここに無い画面はすべて Touch ID を求める。
const FREE_PORTAL_PATHS = ['/', '/start', '/start/'];
const FREE_PORTAL_FRAGMENT = /^(#\/?(\?tab=(accounts|applications))?)?$/;

// Touch ID 通過後、そのタブだけブロックを外しておく時間。
export const UNLOCK_MINUTES = 2;

const toRegexes = (entries) => entries.map((entry) => new RegExp(entry.pattern, 'i'));
const GATED_NAVIGATION_REGEXES = toRegexes(GATED_NAVIGATIONS);
const PORTAL_SITE_REGEXES = toRegexes(PORTAL_SITES);

const matchesAny = (regexes, urlText) => regexes.some((regex) => regex.test(urlText));

function isFreePortalPage(urlText) {
  const url = new URL(urlText);
  return FREE_PORTAL_PATHS.includes(url.pathname) && url.search === '' && FREE_PORTAL_FRAGMENT.test(url.hash);
}

// Touch ID を通したタブで開いてよい URL。ゲートページの遷移先として受け付ける範囲でもある。
export function isUnlockableUrl(urlText) {
  if (!URL.canParse(urlText)) return false;
  return matchesAny(GATED_NAVIGATION_REGEXES, urlText) || matchesAny(PORTAL_SITE_REGEXES, urlText);
}

// Touch ID を通すまで開けない URL。
export function isGatedUrl(urlText) {
  if (!isUnlockableUrl(urlText)) return false;
  return matchesAny(GATED_NAVIGATION_REGEXES, urlText) || !isFreePortalPage(urlText);
}
