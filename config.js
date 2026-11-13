import { AWS_IAM_IDENTITY_CENTER } from './presets.js';

// URL の先頭。https://user@host/ のようにユーザー情報を付けても対象から外れないようにする。
const SCHEME = '^https?://([^/?#@]*@)?';

// Touch ID 通過後、そのタブだけブロックを外しておく時間。
export const UNLOCK_MINUTES = 2;

// ---- 設定 ----

const SETTINGS_STORAGE_KEY = 'settings';
// lines は設定ページに書いた行（対象 URL、例外、コメント、空行）。
export const DEFAULT_SETTINGS = Object.freeze({ lines: [] });

// 0.3 までの設定（AWS プリセットの有効・無効と、追加した URL パターン）を、同じ内容の行に直す。
// 0.3 までは AWS の対象 URL が最初から有効だったので、保存された設定が無い場合も AWS の行を入れる。
// 0.3 までは、追加した URL パターンが AWS の一覧画面の例外より優先だった。いまは例外が優先なので、
// 追加した URL パターンと重なる例外の行は入れず、Touch ID を求めていたページが外れないようにする。
// 0.3 までは「all:8080/admin」が all というホストのポート 8080 を指した。いまは行頭の all: が別の意味なので、
// スキームを付けて、同じ URL を指すようにする（スキームを付けても、http と https の両方が対象になる）。
const escapeLegacyPattern = (pattern) => (ALL_REQUESTS_PREFIX.test(pattern.trim()) ? `http://${pattern.trim()}` : pattern);

export function convertLegacySettings(stored) {
  const customPatterns = Array.isArray(stored?.customPatterns) ? stored.customPatterns.map(escapeLegacyPattern) : [];
  const customGates = customPatterns.flatMap((line) => {
    try {
      const parsed = parseLine(line);
      return parsed.kind === 'gate' ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const overlapsCustomGate = (line) => {
    const parsed = parseLine(line);
    return parsed.kind === 'exception' && customGates.some((gate) => gateOverlapsException(gate, parsed));
  };
  const presetLines =
    stored?.awsPreset === false ? [] : AWS_IAM_IDENTITY_CENTER.lines.filter((line) => !overlapsCustomGate(line));
  const separator = presetLines.length > 0 && customPatterns.length > 0 ? [''] : [];
  return { lines: [...presetLines, ...separator, ...customPatterns] };
}

const isCurrentSettings = (stored) => Array.isArray(stored?.lines);

async function loadStoredSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return stored[SETTINGS_STORAGE_KEY];
}

const toSettings = (stored) => {
  if (stored === undefined) return DEFAULT_SETTINGS;
  return isCurrentSettings(stored) ? stored : convertLegacySettings(stored);
};

export async function loadSettings() {
  return toSettings(await loadStoredSettings());
}

// 保存は Touch ID を検証したバックグラウンドだけが行う。
export async function storeSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

// インストールや更新のあとに、設定をいまの形で保存しておく。対象 URL を減らす変更はしないので、Touch ID は求めない。
// 設定が保存されていないのは、新規インストールか、0.3 までの版で設定を保存しなかった場合。
// 0.3 までの版なら AWS のブロックルールが登録されているので、それで見分ける。
export async function initializeSettings({ hadRulesInstalled }) {
  const stored = await loadStoredSettings();
  if (isCurrentSettings(stored)) return;
  const isNewInstall = stored === undefined && !hadRulesInstalled;
  await storeSettings(isNewInstall ? DEFAULT_SETTINGS : convertLegacySettings(stored));
}

// 設定が変わったら（別のタブで保存した場合も）callback を呼ぶ。
export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(SETTINGS_STORAGE_KEY in changes)) return;
    callback(toSettings(changes[SETTINGS_STORAGE_KEY].newValue));
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

// 設定ページの 1 行を解釈する。行の種類は 3 つ。
// - 対象 URL（example.com/admin）: ページを開く操作（画面の遷移と iframe の読み込み）を止める。
// - 通信も止める対象 URL（all:api.example.com/token）: ページ内のスクリプトからの通信も止める。
// - 例外（!example.com/admin/help）: 対象 URL のうち、Touch ID なしで開けるページ。
//
// 対象 URL の書き方:
// - スキームは書いても書かなくてもよく、http と https の両方が対象になる。
// - ホストの * はホスト名の一部（例: *.example.com, app-*.example.com）、パスの * は任意の文字列。
// - パスは前方一致。パスを省くと、そのホストのすべてのページが対象になる。
// - # 以降は書けない。
// 例外の書き方は同じだが、パスは完全一致（大文字と小文字も区別する）で、# 以降も書ける。
// 外す範囲を広げすぎないように、例外は書いたとおりの URL だけに一致させる。
// 続けて書いた * は 1 つにまとめる。
const EXCEPTION_PREFIX = '!';
// 「all」というホストのポートを書きたいときは、http://all:8080 のようにスキームを付ける。
const ALL_REQUESTS_PREFIX = /^all:/i;
const COMMENT_PREFIX = '#';

const isRuleLine = (text) => text !== '' && !text.startsWith(COMMENT_PREFIX);

function parsePattern(text, { allowsFragment }) {
  if (/\s/.test(text)) throw new Error('空白は使えません');
  const withoutScheme = text.replace(/^(\*|https?):\/\//i, '');
  const hostEnd = withoutScheme.search(/[/?#]/);
  const host = hostEnd === -1 ? withoutScheme : withoutScheme.slice(0, hostEnd);
  // hostEnd が ? や # のとき、ブラウザは / を補うので、パスも / から始める。
  const rest = hostEnd === -1 ? '' : withoutScheme.slice(hostEnd);
  const pathAndFragment = rest === '' || rest.startsWith('/') ? rest : `/${rest}`;
  const fragmentStart = pathAndFragment.indexOf('#');
  const rawPath = fragmentStart === -1 ? pathAndFragment : pathAndFragment.slice(0, fragmentStart);
  const rawFragment = fragmentStart === -1 ? '' : pathAndFragment.slice(fragmentStart);
  // # 以降は通信の URL に含まれず、ブロックルールで止められない（iframe で読み込めば差し替えも効かない）。
  if (rawFragment !== '' && !allowsFragment) throw new Error('# 以降（フラグメント）は、例外（! で始まる行）にだけ書けます');

  const [, rawHostname, rawPort = ''] = host.match(/^(.*?)(?::([0-9]+))?$/);
  if (rawHostname.includes(':')) throw new Error('ポートの書き方が正しくありません');
  // 08443 のような書き方も、ブラウザと同じく 8443 にそろえる。
  const portNumber = Number(rawPort);
  if (rawPort !== '' && (portNumber < 1 || portNumber > 65535)) throw new Error('ポートは 1〜65535 で書いてください');
  const port = rawPort === '' ? '' : String(portNumber);
  const hostname = normalizeHostname(rawHostname).replace(/\*+/g, '*');
  const path = rawPath === '' ? '' : normalizePath(rawPath).replace(/\*+/g, '*');
  // ブラウザは # だけの URL のフラグメントを空として扱うので、それにそろえる。
  const fragment = new URL(`https://placeholder.invalid/${rawFragment}`).hash.replace(/\*+/g, '*');
  return { hostname, port, path, fragment };
}

export function parseLine(line) {
  const text = line.trim();
  if (!isRuleLine(text)) return { kind: 'comment' };
  if (text.startsWith(EXCEPTION_PREFIX)) {
    return { kind: 'exception', ...parsePattern(text.slice(EXCEPTION_PREFIX.length), { allowsFragment: true }) };
  }
  const blocksAllRequests = ALL_REQUESTS_PREFIX.test(text);
  const pattern = parsePattern(text.replace(ALL_REQUESTS_PREFIX, ''), { allowsFragment: false });
  return { kind: 'gate', blocksAllRequests, ...pattern };
}

// ---- ブロックルール用の正規表現（RE2）----

// ホスト部の * はホスト名の中だけ（/ ? # : の手前まで）に一致させる。先頭の *. はサブドメインなしにも一致させる。
// ブラウザは既定のポート（http の 80、https の 443）を URL から省くので、書かれていても省いた URL に一致させる。
function originRegex({ hostname, port }) {
  const hasLeadingWildcard = hostname.startsWith('*.');
  const hostBody = (hasLeadingWildcard ? hostname.slice(2) : hostname).split('*').map(escapeRegex).join('[^/?#:]*');
  const hostRegex = hasLeadingWildcard ? `([^/?#:]*\\.)?${hostBody}` : hostBody;
  const portRegex = port === '' ? '(:[0-9]+)?' : isDefaultPort(port) ? `(:${port})?` : `:${port}`;
  return `${SCHEME}${hostRegex}${portRegex}`;
}

// 対象 URL。パスは前方一致。
function gateToRegex(pattern) {
  const pathRegex = pattern.path === '' ? '([/?#]|$)' : pattern.path.split('*').map(escapeRegex).join('.*');
  return `${originRegex(pattern)}${pathRegex}`;
}

// 例外でパスを省いたら、トップページ（/）だけを指す。
const exceptionPath = (pattern) => (pattern.path === '' ? '/' : pattern.path);

// 例外。通信の URL には # 以降が含まれないので、# の手前までの完全一致にする。
function exceptionToRegex(pattern) {
  const pathRegex = exceptionPath(pattern).split('*').map(escapeRegex).join('[^#]*');
  return `${originRegex(pattern)}${pathRegex}(#.*)?$`;
}

// ---- 遷移の判定 ----

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

function matchesOrigin(url, { hostname, port }) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostMatches =
    matchesGlob(url.hostname, hostname) || (hostname.startsWith('*.') && matchesGlob(url.hostname, hostname.slice(2)));
  const portMatches = port === '' || url.port === port || (isDefaultPort(port) && url.port === '');
  return hostMatches && portMatches;
}

// ページの操作で長い URL を作れるので、正規表現のバックトラックに頼らず、時間の上限がある方法で比べる。
// ブロックルール（gateToRegex）と同じ範囲に一致させる。ブロックルールと同じく、大文字と小文字は区別しない。
function gateMatcher(pattern) {
  const lowerPath = pattern.path.toLowerCase();
  return (urlText) => {
    const url = new URL(urlText);
    return matchesOrigin(url, pattern) && matchesGlobPrefix(`${url.pathname}${url.search}`.toLowerCase(), lowerPath);
  };
}

// 例外は # 以降まで含めた完全一致。# 以降を書いていない例外は、# 以降の無い URL だけに一致する。
// # 以降が無い URL も「#」として比べるので、「#*」と書けば # 以降の有無にかかわらず一致する。
function exceptionMatcher(pattern) {
  const path = exceptionPath(pattern);
  const fragment = pattern.fragment || '#';
  return (urlText) => {
    const url = new URL(urlText);
    return (
      matchesOrigin(url, pattern) &&
      matchesGlob(`${url.pathname}${url.search}`, path) &&
      matchesGlob(url.hash || '#', fragment)
    );
  };
}

// * を含むパターンどうしで、両方に一致する文字列があるか。
function globsIntersect(first, second) {
  const memo = new Map();
  const visit = (firstIndex, secondIndex) => {
    if (firstIndex === first.length && secondIndex === second.length) return true;
    const key = firstIndex * (second.length + 1) + secondIndex;
    if (!memo.has(key)) {
      const hasFirst = firstIndex < first.length;
      const hasSecond = secondIndex < second.length;
      let result;
      if (hasFirst && first[firstIndex] === '*') {
        result = visit(firstIndex + 1, secondIndex) || (hasSecond && visit(firstIndex, secondIndex + 1));
      } else if (hasSecond && second[secondIndex] === '*') {
        result = visit(firstIndex, secondIndex + 1) || (hasFirst && visit(firstIndex + 1, secondIndex));
      } else {
        result = hasFirst && hasSecond && first[firstIndex] === second[secondIndex] && visit(firstIndex + 1, secondIndex + 1);
      }
      memo.set(key, result);
    }
    return memo.get(key);
  };
  return visit(0, 0);
}

// 先頭の *. はサブドメインなしにも一致するので、その形も比べる。
const hostnameForms = (hostname) => (hostname.startsWith('*.') ? [hostname, hostname.slice(2)] : [hostname]);

// 対象 URL と例外の両方に一致する URL がありうるか。対象 URL は # 以降を見ないので、# 以降は比べない。
function gateOverlapsException(gate, exception) {
  const hostsOverlap = hostnameForms(gate.hostname).some((gateHost) =>
    hostnameForms(exception.hostname).some((exceptionHost) => globsIntersect(gateHost, exceptionHost)),
  );
  const portsOverlap =
    gate.port === '' || exception.port === '' || gate.port === exception.port || (isDefaultPort(gate.port) && isDefaultPort(exception.port));
  const pathsOverlap = globsIntersect(`${gate.path.toLowerCase()}*`, exceptionPath(exception).toLowerCase());
  return hostsOverlap && portsOverlap && pathsOverlap;
}

// ---- 設定ページの入力 ----

// 設定ページの入力（1 行に 1 つ）を検証する。重複した行は除く。コメントと空行は、読みやすさのために残す。
export function parseLines(lines) {
  const kept = [];
  const errors = [];
  for (const line of lines) {
    if (typeof line !== 'string') throw new Error('設定の形式が不正です');
    const text = line.trim();
    if (isRuleLine(text)) {
      if (kept.includes(text)) continue;
      try {
        parseLine(text);
      } catch (error) {
        errors.push(`${text}: ${error.message}`);
        continue;
      }
    }
    // 空行は続けて残さない。
    if (text === '' && (kept.length === 0 || kept.at(-1) === '')) continue;
    kept.push(text);
  }
  while (kept.at(-1) === '') kept.pop();
  return { lines: kept, errors };
}

// ---- 判定 ----

// 設定から、対象 URL と例外の一覧を作る。
// - gates: Touch ID を通すまで開けない URL。blocksAllRequests が true なら、ページ内の通信も止める。
// - exceptions: gates のうち、Touch ID なしで開けるページ。
// pattern はブロックルール用の正規表現、test は遷移の判定用。
export function buildRules(settings) {
  const gates = [];
  const exceptions = [];
  for (const line of settings.lines) {
    let parsed;
    try {
      parsed = parseLine(line);
    } catch (error) {
      // 保存時に確かめているので、通常はここには来ない。1 行のために全体を止めないよう、その行だけ飛ばす。
      console.error(`[url-gate] 解釈できない行を無視します: ${line}`, error);
      continue;
    }
    const label = line.trim();
    if (parsed.kind === 'gate') {
      gates.push({ label, pattern: gateToRegex(parsed), test: gateMatcher(parsed), blocksAllRequests: parsed.blocksAllRequests });
    } else if (parsed.kind === 'exception') {
      exceptions.push({ label, pattern: exceptionToRegex(parsed), test: exceptionMatcher(parsed) });
    }
  }
  return { gates, exceptions };
}

export async function loadRules() {
  return buildRules(await loadSettings());
}

const matchesAny = (entries, urlText) => entries.some((entry) => entry.test(urlText));

// Touch ID を通したタブで開いてよい URL（例外のページを含む）。ゲートページの遷移先として受け付ける範囲でもある。
export function isUnlockableUrl(urlText, rules) {
  return URL.canParse(urlText) && matchesAny(rules.gates, urlText);
}

// Touch ID を通すまで開けない URL。
export function isGatedUrl(urlText, rules) {
  return isUnlockableUrl(urlText, rules) && !matchesAny(rules.exceptions, urlText);
}
