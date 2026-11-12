import { isGatedUrl } from './config.js';
import { loadCredential, requestAssertion } from './webauthn.js';

const target = new URLSearchParams(location.search).get('target') ?? '';
const unlockButton = document.getElementById('unlock');
const optionsButton = document.getElementById('open-options');
const status = document.getElementById('status');

document.getElementById('target').textContent = target;

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'バックグラウンドから応答がありません');
  return response;
}

async function unlock() {
  const credential = await loadCredential();
  if (!credential) {
    optionsButton.hidden = false;
    throw new Error('Touch ID が未登録です。先に登録してください。');
  }
  const { challenge } = await sendToBackground({ type: 'challenge' });
  const assertion = await requestAssertion(credential.credentialId, challenge);
  await sendToBackground({ type: 'unlock', assertion, target });
}

if (!isGatedUrl(target)) {
  unlockButton.disabled = true;
  status.textContent = '遷移先が対象 URL ではないため、開けません。';
}

unlockButton.addEventListener('click', async () => {
  unlockButton.disabled = true;
  status.textContent = 'Touch ID を待っています…';
  try {
    await unlock();
    status.textContent = '確認できました。移動します。';
  } catch (error) {
    console.error('[touch-id-gate] 解除に失敗', error);
    status.textContent = `開けませんでした: ${error.message}`;
    unlockButton.disabled = false;
  }
});

optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
