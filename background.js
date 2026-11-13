import {
  UNLOCK_MINUTES,
  buildRules,
  initializeSettings,
  isGatedUrl,
  isUnlockableUrl,
  loadRules,
  onSettingsChanged,
  parseLines,
  storeSettings,
} from './config.js';
import { loadCredential, randomChallenge, verifyAssertion } from './webauthn.js';

// 優先度の高いルールが勝つ。対象 URL のブロック < 例外の許可 < Touch ID を通したタブの許可。
const BLOCK_PRIORITY = 1;
const EXCEPTION_PRIORITY = 2;
const UNLOCK_PRIORITY = 3;
const FRAME_RESOURCE_TYPES = ['main_frame', 'sub_frame'];
// 「通信も止める」対象 URL はページ内の fetch でも呼ばれるので、画面遷移以外の種類もすべて止める。
const ALL_RESOURCE_TYPES = Object.values(chrome.declarativeNetRequest.ResourceType);
// 対象 URL は設定で変わるので、遷移はすべて受け取ってから判定する。
const WATCHED_NAVIGATIONS = { url: [{ schemes: ['http', 'https'] }] };
const RELOCK_ALARM_PREFIX = 'relock:';
const GATE_PAGE_URL = chrome.runtime.getURL('gate.html');
const OPTIONS_PAGE_URL = chrome.runtime.getURL('options.html');

const MILLISECONDS_PER_MINUTE = 60_000;
// Chromium は拡張ページの RP ID を「chrome-extension://<拡張 ID>」として扱う。実装差に備えて拡張 ID 単体も受け付ける。
const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
const ACCEPTED_RP_IDS = [EXTENSION_ORIGIN, chrome.runtime.id];

const challengeKey = (tabId) => `challenge:${tabId}`;
const unlockExpiryKey = (tabId) => `unlockExpiresAt:${tabId}`;

const PREPARED_VERSION_KEY = 'preparedVersion';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

const logError = (context) => (error) => console.error(`[url-gate] ${context}`, error);

// 失敗は installQueue が記録するので、ここでは握りつぶす。
const ignoreError = () => {};

// Chrome が登録を受け付ける正規表現ルールの上限。
const MAX_REGEX_RULES = chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES ?? 1000;

// 設定から作る通信のルール。対象 URL はブロックし、例外はページを開く操作だけ許可する。
// 例外は # 以降だけが違う行が並ぶことがあるので、同じ正規表現は 1 つにまとめる。
function networkRuleCandidates(rules) {
  const exceptionsByPattern = new Map(rules.exceptions.map((entry) => [entry.pattern, entry]));
  return [
    ...rules.gates.map((entry) => ({
      entry,
      priority: BLOCK_PRIORITY,
      actionType: 'block',
      resourceTypes: entry.blocksAllRequests ? ALL_RESOURCE_TYPES : FRAME_RESOURCE_TYPES,
      isCaseSensitive: false,
    })),
    ...[...exceptionsByPattern.values()].map((entry) => ({
      entry,
      priority: EXCEPTION_PRIORITY,
      actionType: 'allow',
      resourceTypes: FRAME_RESOURCE_TYPES,
      isCaseSensitive: true,
    })),
  ];
}

const isRegexSupported = ({ entry, isCaseSensitive }) =>
  chrome.declarativeNetRequest.isRegexSupported({ regex: entry.pattern, isCaseSensitive });

// ルールにできない（RE2 で通らない、大きすぎる）正規表現と、その理由を返す。
async function findUnsupportedRegexes(candidates) {
  const results = await Promise.all(candidates.map(isRegexSupported));
  return candidates
    .map(({ entry }, index) => ({ entry, result: results[index] }))
    .filter(({ result }) => !result.isSupported);
}

// 保存する前に、その設定が通信のルールとして登録できることを確かめる。
async function assertEnforceable(rules) {
  const candidates = networkRuleCandidates(rules);
  if (candidates.length > MAX_REGEX_RULES) {
    throw new Error(`対象 URL と例外が多すぎます（${MAX_REGEX_RULES} 件まで、いまは ${candidates.length} 件）`);
  }
  const unsupported = await findUnsupportedRegexes(candidates);
  if (unsupported.length > 0) {
    const labels = unsupported.map(({ entry, result }) => `${entry.label}（${result.reason}）`);
    throw new Error(`ブロックルールにできない URL パターンがあります: ${labels.join(' / ')}`);
  }
}

async function supportedNetworkRules(rules) {
  const candidates = networkRuleCandidates(rules);
  const unsupported = new Set((await findUnsupportedRegexes(candidates)).map(({ entry }) => entry));
  // 1 つでも通らない正規表現があると全体の登録が失敗するので、通らないものは除いて記録する。
  // 保存時に確かめているので、通常はここで除かれるものはない。除いた対象 URL も、遷移の検知による差し替えは効く。
  for (const entry of unsupported) console.error(`[url-gate] ブロックルールにできない URL: ${entry.label}`);
  return candidates.filter(({ entry }) => !unsupported.has(entry));
}

// 常時ブロック。dynamic rule はブラウザ再起動後も残り、この service worker が止まっていても効く。
async function installBlockRules() {
  const networkRules = await supportedNetworkRules(await loadRules());
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
    addRules: networkRules.map(({ entry, priority, actionType, resourceTypes, isCaseSensitive }, index) => ({
      id: index + 1,
      priority,
      action: { type: actionType },
      condition: {
        regexFilter: entry.pattern,
        isUrlFilterCaseSensitive: isCaseSensitive,
        resourceTypes,
      },
    })),
  });
}

// 登録が重なるとルール ID がぶつかるので、順番に行う。
// 戻り値は今回の登録の結果。失敗しても、次の登録は続けられるようにしておく。
let installQueue = Promise.resolve();
function reinstallBlockRules() {
  const installation = installQueue.then(installBlockRules);
  installQueue = installation.catch(logError('ブロックルールの登録に失敗'));
  return installation;
}

// インストールや更新のあとに、設定をいまの形にそろえ、ブロックルールを作り直す。
async function prepare() {
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  await initializeSettings({ hadRulesInstalled: existingRules.length > 0 });
  await reinstallBlockRules();
  await chrome.storage.local.set({ [PREPARED_VERSION_KEY]: EXTENSION_VERSION });
}

// onInstalled の処理が終わる前に service worker が止まると、準備が済まないまま残る。
// それに備えて、service worker が起きるたびに、いまの版で準備を済ませたかを確かめる。
async function prepareIfVersionChanged() {
  const stored = await chrome.storage.local.get(PREPARED_VERSION_KEY);
  if (stored[PREPARED_VERSION_KEY] !== EXTENSION_VERSION) await prepare();
}

let prepared = prepareIfVersionChanged().catch(logError('起動時の準備に失敗'));

// 設定から作った対象 URL。service worker が起きている間はキャッシュし、設定が変わったら作り直す。
// 準備（設定の移し替え）が済んでから読む。
let rulesPromise = null;
const getRules = () => (rulesPromise ??= prepared.then(loadRules));

// アラームは遅れることがあるので、期限は保存した時刻で判定する。期限切れならここで再ロックする。
async function isTabUnlocked(tabId) {
  const key = unlockExpiryKey(tabId);
  const stored = await chrome.storage.session.get(key);
  if (stored[key] === undefined) return false;
  if (Date.now() < stored[key]) return true;
  await relockTab(tabId);
  return false;
}

// 解除はタブ単位の session rule（ルール ID = タブ ID）。サインイン中にホストをまたぐので URL では絞らない。
// allow が打ち消すのはこの拡張のブロックだけなので、対象外の URL には影響しない。
async function unlockTab(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: UNLOCK_PRIORITY,
        action: { type: 'allow' },
        condition: {
          tabIds: [tabId],
          resourceTypes: ALL_RESOURCE_TYPES,
        },
      },
    ],
  });
  await chrome.storage.session.set({
    [unlockExpiryKey(tabId)]: Date.now() + UNLOCK_MINUTES * MILLISECONDS_PER_MINUTE,
  });
  await chrome.alarms.create(`${RELOCK_ALARM_PREFIX}${tabId}`, { delayInMinutes: UNLOCK_MINUTES });
}

async function relockTab(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
  await chrome.storage.session.remove(unlockExpiryKey(tabId));
  await chrome.alarms.clear(`${RELOCK_ALARM_PREFIX}${tabId}`);
}

async function showGate(tabId, targetUrl) {
  if (await isTabUnlocked(tabId)) return;
  await chrome.tabs.update(tabId, {
    url: `${GATE_PAGE_URL}?target=${encodeURIComponent(targetUrl)}`,
  });
}

async function redirectToGate(details) {
  if (details.frameId !== 0 || !isGatedUrl(details.url, await getRules())) return;
  await showGate(details.tabId, details.url);
}

// ツールバーのボタン。例外のページを開いたまま、止めている通信を使いたいときなどに、いま開いているタブを解除する。
async function showGateForCurrentPage(tab) {
  if (tab.id === undefined || !isUnlockableUrl(tab.url ?? '', await getRules())) return;
  await showGate(tab.id, tab.url);
}

async function issueChallenge(_message, tabId) {
  const challenge = randomChallenge();
  await chrome.storage.session.set({ [challengeKey(tabId)]: challenge });
  return { challenge };
}

// このタブに発行したチャレンジへの署名を検証する。失敗したら例外を投げる。
async function verifyTouchId(assertion, tabId) {
  const key = challengeKey(tabId);
  const stored = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  const expectedChallenge = stored[key];
  if (!expectedChallenge) throw new Error('チャレンジが発行されていません');

  const credential = await loadCredential();
  if (!credential) throw new Error('Touch ID が未登録です');

  await verifyAssertion({
    publicKeySpki: credential.publicKeySpki,
    algorithm: credential.algorithm,
    assertion,
    expectedChallenge,
    expectedOrigin: EXTENSION_ORIGIN,
    acceptedRpIds: ACCEPTED_RP_IDS,
  });
}

async function unlockWithAssertion(message, tabId) {
  if (!isUnlockableUrl(message.target, await getRules())) throw new Error('遷移先が対象 URL ではありません');
  await verifyTouchId(message.assertion, tabId);
  await unlockTab(tabId);
  await chrome.tabs.update(tabId, { url: message.target });
  return {};
}

// 対象 URL を外す操作でもあるので、設定の保存にも Touch ID を求める。
async function saveSettingsWithAssertion(message, tabId) {
  if (!Array.isArray(message.settings?.lines)) throw new Error('設定の形式が不正です');
  const { lines, errors } = parseLines(message.settings.lines);
  if (errors.length > 0) throw new Error(`書き方が正しくない行があります: ${errors.join(' / ')}`);
  const settings = { lines };
  await assertEnforceable(buildRules(settings));
  await verifyTouchId(message.assertion, tabId);
  await storeSettings(settings);

  // 保存の結果として、ブロックルールまで登録できたかを返す。
  rulesPromise = null;
  try {
    await reinstallBlockRules();
  } catch (error) {
    throw new Error(`設定は保存しましたが、ブロックルールの登録に失敗しました: ${error.message}`);
  }
  return {};
}

// メッセージの種類ごとに、受け付ける送り主のページを決めておく。
const MESSAGE_HANDLERS = {
  challenge: { handle: issueChallenge, pages: [GATE_PAGE_URL, OPTIONS_PAGE_URL] },
  unlock: { handle: unlockWithAssertion, pages: [GATE_PAGE_URL] },
  saveSettings: { handle: saveSettingsWithAssertion, pages: [OPTIONS_PAGE_URL] },
};

chrome.runtime.onInstalled.addListener(({ reason }) => {
  prepared = prepared.then(prepare).catch(logError('インストール後の準備に失敗'));
  rulesPromise = null;
  // インストールしただけでは何も止めないので、最初に設定ページ（Touch ID の登録と対象 URL）を開く。
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.runtime.openOptionsPage().catch(logError('設定ページを開けませんでした'));
  }
});

onSettingsChanged(() => {
  rulesPromise = null;
  reinstallBlockRules().catch(ignoreError);
});

// 画面の切り替えで # だけが変わるサイトがあるので、ページの読み込み以外の遷移も見る。
// onCommitted は、対象外の URL からリダイレクトで着いた場合の最終 URL を拾うために必要。
const NAVIGATION_EVENTS = [
  chrome.webNavigation.onBeforeNavigate,
  chrome.webNavigation.onCommitted,
  chrome.webNavigation.onReferenceFragmentUpdated,
  chrome.webNavigation.onHistoryStateUpdated,
];
for (const navigationEvent of NAVIGATION_EVENTS) {
  navigationEvent.addListener((details) => {
    redirectToGate(details).catch(logError('ゲートページへの差し替えに失敗'));
  }, WATCHED_NAVIGATIONS);
}

chrome.action.onClicked.addListener((tab) => {
  showGateForCurrentPage(tab).catch(logError('ゲートページの表示に失敗'));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const handler = MESSAGE_HANDLERS[message?.type];
  const isFromAllowedPage =
    sender.id === chrome.runtime.id && handler?.pages.some((page) => sender.url?.startsWith(page));
  if (!handler || !isFromAllowedPage || tabId === undefined) return false;

  handler.handle(message, tabId).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => {
      logError(`${message.type} の処理に失敗`)(error);
      sendResponse({ ok: false, error: error.message });
    },
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(RELOCK_ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(RELOCK_ALARM_PREFIX.length));
  relockTab(tabId).catch(logError('再ロックに失敗'));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  relockTab(tabId).catch(logError('タブ終了時の再ロックに失敗'));
});
