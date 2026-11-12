import { GATED_URLS, UNLOCK_MINUTES, isGatedUrl } from './config.js';
import { loadCredential, randomChallenge, verifyAssertion } from './webauthn.js';

const BLOCK_PRIORITY = 1;
const ALLOW_PRIORITY = 2;
const FRAME_RESOURCE_TYPES = ['main_frame', 'sub_frame'];
const RELOCK_ALARM_PREFIX = 'relock:';
const GATE_PAGE_URL = chrome.runtime.getURL('gate.html');

const MILLISECONDS_PER_MINUTE = 60_000;
// Chromium は拡張ページの RP ID を「chrome-extension://<拡張 ID>」として扱う。実装差に備えて拡張 ID 単体も受け付ける。
const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
const ACCEPTED_RP_IDS = [EXTENSION_ORIGIN, chrome.runtime.id];

const challengeKey = (tabId) => `challenge:${tabId}`;
const unlockExpiryKey = (tabId) => `unlockExpiresAt:${tabId}`;

// 常時ブロック。dynamic rule はブラウザ再起動後も残り、この service worker が止まっていても効く。
async function installBlockRules() {
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
    addRules: GATED_URLS.map((gated, index) => ({
      id: index + 1,
      priority: BLOCK_PRIORITY,
      action: { type: 'block' },
      condition: {
        regexFilter: gated.pattern,
        resourceTypes: FRAME_RESOURCE_TYPES,
      },
    })),
  });
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
          resourceTypes: FRAME_RESOURCE_TYPES,
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

async function redirectToGate(details) {
  if (details.frameId !== 0 || !isGatedUrl(details.url)) return;
  if (await isTabUnlocked(details.tabId)) return;
  await chrome.tabs.update(details.tabId, {
    url: `${GATE_PAGE_URL}?target=${encodeURIComponent(details.url)}`,
  });
}

async function issueChallenge(_message, tabId) {
  const challenge = randomChallenge();
  await chrome.storage.session.set({ [challengeKey(tabId)]: challenge });
  return { challenge };
}

async function unlockWithAssertion(message, tabId) {
  if (!isGatedUrl(message.target)) throw new Error('遷移先が対象 URL ではありません');

  const key = challengeKey(tabId);
  const stored = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  const expectedChallenge = stored[key];
  if (!expectedChallenge) throw new Error('チャレンジが発行されていません');

  const credential = await loadCredential();
  if (!credential) throw new Error('Touch ID が未登録です');

  await verifyAssertion({
    publicKeySpki: credential.publicKeySpki,
    assertion: message.assertion,
    expectedChallenge,
    expectedOrigin: EXTENSION_ORIGIN,
    acceptedRpIds: ACCEPTED_RP_IDS,
  });

  await unlockTab(tabId);
  await chrome.tabs.update(tabId, { url: message.target });
  return {};
}

const MESSAGE_HANDLERS = {
  challenge: issueChallenge,
  unlock: unlockWithAssertion,
};

const logError = (context) => (error) => console.error(`[touch-id-gate] ${context}`, error);

chrome.runtime.onInstalled.addListener(() => {
  installBlockRules().catch(logError('ブロックルールの登録に失敗'));
});

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    redirectToGate(details).catch(logError('ゲートページへの差し替えに失敗'));
  },
  {
    url: GATED_URLS.map((gated) => ({ urlMatches: gated.pattern })),
  },
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const handler = MESSAGE_HANDLERS[message?.type];
  const isFromGatePage = sender.id === chrome.runtime.id && sender.url?.startsWith(GATE_PAGE_URL);
  if (!handler || !isFromGatePage || tabId === undefined) return false;

  handler(message, tabId).then(
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
