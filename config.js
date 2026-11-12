// URL の先頭。https://user@host/ のようにユーザー情報を付けても対象から外れないようにする。
const SCHEME = '^https?://([^/?#@]*@)?';
const SUBDOMAINS = '([a-z0-9-]+\\.)*';
const REGION = '[a-z0-9-]+';

// pattern は RE2（ブロックルール用）と JavaScript の両方で通る書き方にする。

// AWS IAM Identity Center（旧 AWS SSO）のプリセット。リージョンとサブドメインは任意。
// 設定ページで無効にしない限り有効。
export const AWS_PRESET = {
  // 開く前に必ず Touch ID を求める URL。
  gatedNavigations: [
    { label: 'oidc.*.amazonaws.com/authorize*', pattern: `${SCHEME}oidc\\.${REGION}\\.amazonaws\\.com/authorize` },
    { label: 'oidc.*.api.aws/authorize*', pattern: `${SCHEME}oidc\\.${REGION}\\.api\\.aws/authorize` },
    { label: 'device.sso.*.amazonaws.com/*', pattern: `${SCHEME}device\\.sso\\.${REGION}\\.amazonaws\\.com/` },
  ],

  // AWS access portal。一覧画面だけは Touch ID なしで開け、それ以外の画面は Touch ID を求める。
  // URL の # 以降はネットワーク層に届かないので、ここはブロックルールではなく遷移の検知で判定する。
  portalSites: [
    { label: '*.awsapps.com/start*', pattern: `${SCHEME}${SUBDOMAINS}awsapps\\.com/start` },
    { label: '*.portal.*.app.aws/*', pattern: `${SCHEME}${SUBDOMAINS}portal\\.${REGION}\\.app\\.aws/` },
    { label: '*.*.portal.amazonaws.com/*', pattern: `${SCHEME}${SUBDOMAINS}${REGION}\\.portal\\.amazonaws\\.com/` },
  ],

  // ポータルが認証情報を取り出す通信（コンソールのサインイン URL、アクセスキー）と、
  // デバイスコードを承認する通信。画面を移動せずに呼べるので、Touch ID を通したタブ以外ではネットワーク層で止める。
  credentialRequests: [
    {
      label: 'portal.sso.*.amazonaws.com/federation/*',
      pattern: `${SCHEME}portal\\.sso\\.${REGION}\\.amazonaws\\.com/federation/`,
    },
    { label: 'portal.sso.*.api.aws/federation/*', pattern: `${SCHEME}portal\\.sso\\.${REGION}\\.api\\.aws/federation/` },
    {
      label: 'oidc.*.amazonaws.com/device_authorization/*',
      pattern: `${SCHEME}oidc\\.${REGION}\\.amazonaws\\.com/device_authorization/`,
    },
    {
      label: 'oidc.*.api.aws/device_authorization/*',
      pattern: `${SCHEME}oidc\\.${REGION}\\.api\\.aws/device_authorization/`,
    },
  ],
};

// Touch ID なしで開けるポータルの画面（一覧）。ここに無い画面はすべて Touch ID を求める。
const FREE_PORTAL_PATHS = ['/', '/start', '/start/'];
const FREE_PORTAL_FRAGMENT = /^(#\/?(\?tab=(accounts|applications))?)?$/;

// Touch ID 通過後、そのタブだけブロックを外しておく時間。
export const UNLOCK_MINUTES = 2;

// ---- 設定 ----

const SETTINGS_STORAGE_KEY = 'settings';
export const DEFAULT_SETTINGS = Object.freeze({ awsPreset: true, customPatterns: [] });

export async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY] };
}

// 保存は Touch ID を検証したバックグラウンドだけが行う。
export async function storeSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

// 設定が変わったら（別のタブで保存した場合も）callback を呼ぶ。
export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(SETTINGS_STORAGE_KEY in changes)) return;
    callback({ ...DEFAULT_SETTINGS, ...changes[SETTINGS_STORAGE_KEY].newValue });
  });
}

// ---- URL パターン ----

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ホスト部の * はホスト名の中だけ（/ ? # : の手前まで）に一致させる。先頭の *. はサブドメインなしにも一致させる。
function hostToRegex(host) {
  const hostname = host.replace(/:[0-9]+$/, '');
  const hasLeadingWildcard = hostname.startsWith('*.');
  const body = (hasLeadingWildcard ? hostname.slice(2) : hostname).split('*').map(escapeRegex).join('[^/?#:]*');
  return hasLeadingWildcard ? `([^/?#:]*\\.)?${body}` : body;
}

// ブラウザは既定のポート（http の 80、https の 443）を URL から省くので、書かれていても省いた URL に一致させる。
function portToRegex(host) {
  const port = host.match(/:([0-9]+)$/)?.[1];
  if (port === undefined) return '(:[0-9]+)?';
  return port === '80' || port === '443' ? `(:${port})?` : `:${port}`;
}

// パス以降を、ブラウザが URL を書き出すときと同じ形にする（日本語などのパーセントエンコード、. や .. の解決）。
// * は URL の中でそのまま残るので、ワイルドカードの位置は変わらない。
function normalizePath(path) {
  // new URL(path, base) だと // から始まるパスがホストとして解釈されるので、文字列でつなぐ。
  const url = new URL(`https://placeholder.invalid${path}`);
  return `${url.pathname}${url.search}${url.hash}`;
}

// 設定ページで書く URL パターンを、ブロックルールと遷移の判定に使う正規表現にする。
// - スキームは書いても書かなくてもよく、http と https の両方が対象になる。
// - ホストの * はホスト名の一部（例: *.example.com, app-*.example.com）、パスの * は任意の文字列。
// - パスは前方一致。パスを省くと、そのホストのすべてのページが対象になる。
export function patternToRegex(text) {
  const withoutScheme = text.trim().replace(/^(\*|https?):\/\//i, '');
  const hostEnd = withoutScheme.search(/[/?#]/);
  const host = (hostEnd === -1 ? withoutScheme : withoutScheme.slice(0, hostEnd)).toLowerCase();
  // hostEnd が ? や # のとき、ブラウザは / を補うので、パスも / から始める。
  const rest = hostEnd === -1 ? '' : withoutScheme.slice(hostEnd);
  const path = rest === '' || rest.startsWith('/') ? rest : `/${rest}`;

  if (!/^[a-z0-9.*-]+(:[0-9]+)?$/.test(host)) throw new Error('ホスト名に使えない文字があります');
  if (!/[a-z0-9]/.test(host.replace(/:[0-9]+$/, ''))) throw new Error('ホスト名を * だけにはできません');
  if (/\s/.test(path)) throw new Error('空白は使えません');

  const pathRegex = path === '' ? '([/?#]|$)' : normalizePath(path).split('*').map(escapeRegex).join('.*');
  return `${SCHEME}${hostToRegex(host)}${portToRegex(host)}${pathRegex}`;
}

// 設定ページの入力（1 行に 1 つ）を検証する。空行と重複は除く。
export function parseCustomPatterns(lines) {
  const patterns = [];
  const errors = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === '' || patterns.includes(text)) continue;
    try {
      patternToRegex(text);
      patterns.push(text);
    } catch (error) {
      errors.push(`${text}: ${error.message}`);
    }
  }
  return { patterns, errors };
}

// ---- 判定 ----

const compile = (entries) => entries.map((entry) => ({ ...entry, regex: new RegExp(entry.pattern, 'i') }));

// 設定から、対象 URL の一覧を作る。
export function buildRules(settings) {
  const customNavigations = settings.customPatterns.map((text) => ({ label: text, pattern: patternToRegex(text) }));
  const preset = settings.awsPreset ? AWS_PRESET : { gatedNavigations: [], portalSites: [], credentialRequests: [] };
  return {
    gatedNavigations: compile([...preset.gatedNavigations, ...customNavigations]),
    portalSites: compile(preset.portalSites),
    credentialRequests: compile(preset.credentialRequests),
  };
}

export async function loadRules() {
  return buildRules(await loadSettings());
}

const matchesAny = (entries, urlText) => entries.some((entry) => entry.regex.test(urlText));

function isFreePortalPage(urlText) {
  const url = new URL(urlText);
  return FREE_PORTAL_PATHS.includes(url.pathname) && url.search === '' && FREE_PORTAL_FRAGMENT.test(url.hash);
}

// Touch ID を通したタブで開いてよい URL。ゲートページの遷移先として受け付ける範囲でもある。
export function isUnlockableUrl(urlText, rules) {
  if (!URL.canParse(urlText)) return false;
  return matchesAny(rules.gatedNavigations, urlText) || matchesAny(rules.portalSites, urlText);
}

// Touch ID を通すまで開けない URL。
export function isGatedUrl(urlText, rules) {
  if (!isUnlockableUrl(urlText, rules)) return false;
  return matchesAny(rules.gatedNavigations, urlText) || !isFreePortalPage(urlText);
}
