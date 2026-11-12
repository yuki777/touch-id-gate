const SUBDOMAINS = '([a-z0-9-]+\\.)*';
const REGION = '[a-z0-9-]+';

// Touch ID を通るまで開けない URL。リージョンは任意。pattern は RE2 と JavaScript の両方で通る書き方にする。
// URL の # 以降はネットワーク層に届かないため、ポータルは /start 配下をまるごと対象にする。
export const GATED_URLS = [
  { label: '*.awsapps.com/start*', pattern: `^https?://${SUBDOMAINS}awsapps\\.com/start` },
  { label: '*.portal.*.app.aws/*', pattern: `^https?://${SUBDOMAINS}portal\\.${REGION}\\.app\\.aws/` },
  { label: '*.*.portal.amazonaws.com/*', pattern: `^https?://${SUBDOMAINS}${REGION}\\.portal\\.amazonaws\\.com/` },
  { label: 'oidc.*.amazonaws.com/authorize*', pattern: `^https?://oidc\\.${REGION}\\.amazonaws\\.com/authorize` },
  { label: 'oidc.*.api.aws/authorize*', pattern: `^https?://oidc\\.${REGION}\\.api\\.aws/authorize` },
  { label: 'device.sso.*.amazonaws.com/*', pattern: `^https?://device\\.sso\\.${REGION}\\.amazonaws\\.com/` },
];

// Touch ID 通過後、そのタブだけブロックを外しておく時間。
export const UNLOCK_MINUTES = 2;

const GATED_REGEXES = GATED_URLS.map((gated) => new RegExp(gated.pattern, 'i'));

export function isGatedUrl(urlText) {
  if (!URL.canParse(urlText)) return false;
  return GATED_REGEXES.some((regex) => regex.test(urlText));
}
