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
const isDefaultPort = (port) => port === '80' || port === '443';

// パス以降を、ブラウザが URL を書き出すときと同じ形にする（日本語などのパーセントエンコード、. や .. の解決）。
// * は URL の中でそのまま残るので、ワイルドカードの位置は変わらない。
function normalizePath(path) {
  // new URL(path, base) だと // から始まるパスがホストとして解釈されるので、文字列でつなぐ。
  const url = new URL(`https://placeholder.invalid${path}`);
  return `${url.pathname}${url.search}`;
}

// ホスト名の * の代わりに URL の解析へ渡す文字列。Chrome はホスト名の * をエスケープするので、置き換えてから解析する。
const WILDCARD_LABEL = 'wildcard0x2a';
const countOf = (text, part) => text.split(part).length - 1;

// ホスト名を、ブラウザが URL を書き出すときと同じ形にする（小文字化、日本語ドメインの punycode 化、
// 127.1 のような IPv4 の省略形の展開）。
function normalizeHostname(hostname) {
  if (/[@[\]\\%]/.test(hostname)) throw new Error('ホスト名に使えない文字があります');
  if (hostname.toLowerCase().includes(WILDCARD_LABEL)) throw new Error('ホスト名に使えない文字があります');
  const replaced = hostname.replaceAll('*', WILDCARD_LABEL);
  let parsed;
  try {
    parsed = new URL(`http://${replaced}`).hostname;
  } catch {
    throw new Error('ホスト名を解釈できません');
  }
  // 日本語と * を同じラベルに書くと、punycode 化で * の位置が分からなくなる。
  const mixesWithPunycode = parsed.split('.').some((label) => label.startsWith('xn--') && label.includes(WILDCARD_LABEL));
  if (mixesWithPunycode || countOf(parsed, WILDCARD_LABEL) !== countOf(replaced, WILDCARD_LABEL)) {
    throw new Error('* と日本語は、ドメインの同じ区切り（. と . の間）に書けません');
  }
  const normalized = parsed.replaceAll(WILDCARD_LABEL, '*');
  if (!/^[a-z0-9.*_-]+$/.test(normalized)) throw new Error('ホスト名に使えない文字があります');
  if (!/[a-z0-9]/.test(normalized)) throw new Error('ホスト名を * だけにはできません');
  return normalized;
}

// 設定ページで書く URL パターンを解釈する。
// - スキームは書いても書かなくてもよく、http と https の両方が対象になる。
// - ホストの * はホスト名の一部（例: *.example.com, app-*.example.com）、パスの * は任意の文字列。
// - パスは前方一致。パスを省くと、そのホストのすべてのページが対象になる。
// - # 以降は書けない。
// 続けて書いた * は 1 つにまとめる。
export function parsePattern(text) {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) throw new Error('空白は使えません');
  const withoutScheme = trimmed.replace(/^(\*|https?):\/\//i, '');
  const hostEnd = withoutScheme.search(/[/?#]/);
  const host = hostEnd === -1 ? withoutScheme : withoutScheme.slice(0, hostEnd);
  // hostEnd が ? のとき、ブラウザは / を補うので、パスも / から始める。
  const rest = hostEnd === -1 ? '' : withoutScheme.slice(hostEnd);
  const rawPath = rest === '' || rest.startsWith('/') ? rest : `/${rest}`;
  // # 以降は通信の URL に含まれず、ブロックルールで止められない（iframe で読み込めば差し替えも効かない）。
  if (rawPath.includes('#')) throw new Error('# 以降（フラグメント）は使えません');

  const [, rawHostname, port = ''] = host.match(/^(.*?)(?::([0-9]+))?$/);
  if (rawHostname.includes(':')) throw new Error('ポートの書き方が正しくありません');
  const hostname = normalizeHostname(rawHostname).replace(/\*+/g, '*');
  const path = rawPath === '' ? '' : normalizePath(rawPath).replace(/\*+/g, '*');
  return { hostname, port, path };
}

// ブロックルール用の正規表現（RE2）にする。
// ホスト部の * はホスト名の中だけ（/ ? # : の手前まで）に一致させる。先頭の *. はサブドメインなしにも一致させる。
// ブラウザは既定のポート（http の 80、https の 443）を URL から省くので、書かれていても省いた URL に一致させる。
export function patternToRegex(text) {
  const { hostname, port, path } = parsePattern(text);
  const hasLeadingWildcard = hostname.startsWith('*.');
  const hostBody = (hasLeadingWildcard ? hostname.slice(2) : hostname).split('*').map(escapeRegex).join('[^/?#:]*');
  const hostRegex = hasLeadingWildcard ? `([^/?#:]*\\.)?${hostBody}` : hostBody;
  const portRegex = port === '' ? '(:[0-9]+)?' : isDefaultPort(port) ? `(:${port})?` : `:${port}`;
  const pathRegex = path === '' ? '([/?#]|$)' : path.split('*').map(escapeRegex).join('.*');
  return `${SCHEME}${hostRegex}${portRegex}${pathRegex}`;
}

// * だけを含むパターンとの完全一致。バックトラックは直前の * までに限るので、時間は文字数の積で抑えられる。
function matchesGlob(text, glob) {
  let textIndex = 0;
  let globIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;
  while (textIndex < text.length) {
    if (globIndex < glob.length && glob[globIndex] === '*') {
      starIndex = globIndex++;
      starTextIndex = textIndex;
    } else if (globIndex < glob.length && glob[globIndex] === text[textIndex]) {
      globIndex++;
      textIndex++;
    } else if (starIndex !== -1) {
      globIndex = starIndex + 1;
      textIndex = ++starTextIndex;
    } else {
      return false;
    }
  }
  while (glob[globIndex] === '*') globIndex++;
  return globIndex === glob.length;
}

// 前方一致。* で区切った断片を、左から順にいちばん手前の位置で探す（後ろに何が続いてもよいので、これで足りる）。
function matchesGlobPrefix(text, glob) {
  const [head, ...parts] = glob.split('*');
  if (!text.startsWith(head)) return false;
  let position = head.length;
  for (const part of parts) {
    const index = text.indexOf(part, position);
    if (index === -1) return false;
    position = index + part.length;
  }
  return true;
}

// 遷移の判定用。ページの操作で長い URL を作れるので、正規表現のバックトラックに頼らず、時間の上限がある方法で比べる。
// ブロックルール（patternToRegex）と同じ範囲に一致させる。
function patternToMatcher(text) {
  const { hostname, port, path } = parsePattern(text);
  const lowerPath = path.toLowerCase();
  return (urlText) => {
    const url = new URL(urlText);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostMatches =
      matchesGlob(url.hostname, hostname) ||
      (hostname.startsWith('*.') && matchesGlob(url.hostname, hostname.slice(2)));
    const portMatches = port === '' || url.port === port || (isDefaultPort(port) && url.port === '');
    const pathMatches = matchesGlobPrefix(`${url.pathname}${url.search}`.toLowerCase(), lowerPath);
    return hostMatches && portMatches && pathMatches;
  };
}

// 設定ページの入力（1 行に 1 つ）を検証する。空行と重複は除く。
export function parseCustomPatterns(lines) {
  const patterns = [];
  const errors = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === '' || patterns.includes(text)) continue;
    try {
      parsePattern(text);
      patterns.push(text);
    } catch (error) {
      errors.push(`${text}: ${error.message}`);
    }
  }
  return { patterns, errors };
}

// ---- 判定 ----

// プリセットの正規表現は固定で、バックトラックが膨らむ形を含まない。
const compile = (entries) =>
  entries.map((entry) => {
    const regex = new RegExp(entry.pattern, 'i');
    return { ...entry, test: (urlText) => regex.test(urlText) };
  });

const compileCustom = (patterns) =>
  patterns.map((text) => ({ label: text, pattern: patternToRegex(text), test: patternToMatcher(text) }));

// 設定から、対象 URL の一覧を作る。
export function buildRules(settings) {
  const preset = settings.awsPreset ? AWS_PRESET : { gatedNavigations: [], portalSites: [], credentialRequests: [] };
  return {
    gatedNavigations: [...compile(preset.gatedNavigations), ...compileCustom(settings.customPatterns)],
    portalSites: compile(preset.portalSites),
    credentialRequests: compile(preset.credentialRequests),
  };
}

export async function loadRules() {
  return buildRules(await loadSettings());
}

const matchesAny = (entries, urlText) => entries.some((entry) => entry.test(urlText));

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
