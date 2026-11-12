import {
  UNLOCK_MINUTES,
  isGatedUrl,
  isUnlockableUrl,
  loadRules,
  onSettingsChanged,
  parseCustomPatterns,
  storeSettings,
} from './config.js';
import { loadCredential, randomChallenge, verifyAssertion } from './webauthn.js';

const BLOCK_PRIORITY = 1;
const ALLOW_PRIORITY = 2;
const FRAME_RESOURCE_TYPES = ['main_frame', 'sub_frame'];
// 認証情報の通信はページ内の fetch で呼ばれるので、画面遷移以外の種類もすべて止める。
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

// 設定から作った対象 URL。service worker が起きている間はキャッシュし、設定が変わったら作り直す。
let rulesPromise = null;
const getRules = () => (rulesPromise ??= loadRules());

async function supportedBlockRules(rules) {
  const candidates = [
    ...rules.gatedNavigations.map((entry) => ({ entry, resourceTypes: FRAME_RESOURCE_TYPES })),
    ...rules.credentialRequests.map((entry) => ({ entry, resourceTypes: ALL_RESOURCE_TYPES })),
  ];
  const results = await Promise.all(
    candidates.map(({ entry }) => chrome.declarativeNetRequest.isRegexSupported({ regex: entry.pattern })),
  );
  // 1 つでも通らない正規表現があると全体の登録が失敗するので、通らないものは除いて記録する。
  // 除いた URL も、遷移の検知による差し替えは効く。
  return candidates.filter(({ entry }, index) => {
    if (results[index].isSupported) return true;
    console.error(`[touch-id-gate] ブロックルールにできない URL: ${entry.label}（${results[index].reason}）`);
    return false;
  });
}

// 常時ブロック。dynamic rule はブラウザ再起動後も残り、この service worker が止まっていても効く。
async function installBlockRules() {
  const blockRules = await supportedBlockRules(await getRules());
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
    addRules: blockRules.map(({ entry, resourceTypes }, index) => ({
      id: index + 1,
      priority: BLOCK_PRIORITY,
      action: { type: 'block' },
      condition: {
        regexFilter: entry.pattern,
        resourceTypes,
      },
    })),
  });
}

// 登録が重なるとルール ID がぶつかるので、順番に行う。
let installQueue = Promise.resolve();
function reinstallBlockRules() {
  installQueue = installQueue.then(installBlockRules).catch(logError('ブロックルールの登録に失敗'));
  return installQueue;
}

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
        priority: ALLOW_PRIORITY,
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

// ツールバーのボタン。一覧画面のままアクセスキーを表示したいときなどに、いま開いているタブを解除する。
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
  const lines = message.settings?.customPatterns;
  if (!Array.isArray(lines)) throw new Error('設定の形式が不正です');
  const { patterns, errors } = parseCustomPatterns(lines);
  if (errors.length > 0) throw new Error(`書き方が正しくない URL パターンがあります: ${errors.join(' / ')}`);
  await verifyTouchId(message.assertion, tabId);
  await storeSettings({ awsPreset: message.settings.awsPreset === true, customPatterns: patterns });
  return {};
}

// メッセージの種類ごとに、受け付ける送り主のページを決めておく。
const MESSAGE_HANDLERS = {
  challenge: { handle: issueChallenge, pages: [GATE_PAGE_URL, OPTIONS_PAGE_URL] },
  unlock: { handle: unlockWithAssertion, pages: [GATE_PAGE_URL] },
  saveSettings: { handle: saveSettingsWithAssertion, pages: [OPTIONS_PAGE_URL] },
};

const logError = (context) => (error) => console.error(`[touch-id-gate] ${context}`, error);

chrome.runtime.onInstalled.addListener(() => {
  reinstallBlockRules();
});

onSettingsChanged(() => {
  rulesPromise = null;
  reinstallBlockRules();
});

// ポータルは画面の切り替えで # だけが変わることがあるので、ページの読み込み以外の遷移も見る。
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
