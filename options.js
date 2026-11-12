import { CREDENTIAL_REQUESTS, GATED_NAVIGATIONS, PORTAL_SITES } from './config.js';
import { loadCredential, registerCredential } from './webauthn.js';

const state = document.getElementById('state');
const status = document.getElementById('status');
const registerButton = document.getElementById('register');

async function showState() {
  const credential = await loadCredential();
  state.textContent = credential
    ? '登録済みです。登録し直すと、以前の登録は使えなくなります。'
    : '未登録です。登録するまで対象 URL は開けません。';
  registerButton.textContent = credential ? 'Touch ID を登録し直す' : 'Touch ID を登録する';
}

const GATED_LABELS = [
  ...GATED_NAVIGATIONS.map((entry) => entry.label),
  ...PORTAL_SITES.map((entry) => `${entry.label}（一覧画面を除く）`),
  ...CREDENTIAL_REQUESTS.map((entry) => `${entry.label}（通信）`),
];

document.getElementById('gated-urls').append(
  ...GATED_LABELS.map((label) => {
    const item = document.createElement('li');
    item.textContent = label;
    return item;
  }),
);

registerButton.addEventListener('click', async () => {
  registerButton.disabled = true;
  status.textContent = 'Touch ID を待っています…';
  try {
    await registerCredential();
    status.textContent = '登録しました。';
  } catch (error) {
    console.error('[touch-id-gate] 登録に失敗', error);
    status.textContent = `登録できませんでした: ${error.message}`;
  } finally {
    registerButton.disabled = false;
    await showState();
  }
});

showState().catch((error) => {
  console.error('[touch-id-gate] 状態の取得に失敗', error);
  state.textContent = `状態を取得できませんでした: ${error.message}`;
});
