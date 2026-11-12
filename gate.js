import { isUnlockableUrl } from './config.js';
import { loadCredential, requestAssertion } from './webauthn.js';

const target = new URLSearchParams(location.search).get('target') ?? '';
const unlockButton = document.getElementById('unlock');
const optionsButton = document.getElementById('open-options');
const status = document.getElementById('status');

const NOT_REGISTERED_MESSAGE = 'Touch ID が未登録です。「Touch ID を登録する」から登録してから、もう一度押してください。';

document.getElementById('target').textContent = target;

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'バックグラウンドから応答がありません');
  return response;
}

// 未登録は想定どおりの状態なので、エラーとして記録せずに登録を案内する。
function showNotRegistered() {
  optionsButton.hidden = false;
  status.textContent = NOT_REGISTERED_MESSAGE;
}

// 登録されていれば解除して true、未登録なら何もせず false を返す。
async function unlock() {
  const credential = await loadCredential();
  if (!credential) return false;
  optionsButton.hidden = true;
  const { challenge } = await sendToBackground({ type: 'challenge' });
  const assertion = await requestAssertion(credential.credentialId, challenge);
  await sendToBackground({ type: 'unlock', assertion, target });
  return true;
}

if (!isUnlockableUrl(target)) {
  unlockButton.disabled = true;
  status.textContent = '遷移先が対象 URL ではないため、開けません。';
} else {
  loadCredential()
    .then((credential) => {
      if (!credential) showNotRegistered();
    })
    .catch((error) => console.error('[touch-id-gate] 登録状態の取得に失敗', error));
}

unlockButton.addEventListener('click', async () => {
  unlockButton.disabled = true;
  status.textContent = 'Touch ID を待っています…';
  try {
    if (await unlock()) {
      status.textContent = '確認できました。移動します。';
    } else {
      showNotRegistered();
      unlockButton.disabled = false;
    }
  } catch (error) {
    console.error('[touch-id-gate] 解除に失敗', error);
    status.textContent = `開けませんでした: ${error.message}`;
    unlockButton.disabled = false;
  }
});

optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
