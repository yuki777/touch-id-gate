import { GATED_URLS } from './config.js';
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

document.getElementById('gated-urls').append(
  ...GATED_URLS.map((gated) => {
    const item = document.createElement('li');
    item.textContent = gated.label;
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
    console.error('[sso-touchid-gate] 登録に失敗', error);
    status.textContent = `登録できませんでした: ${error.message}`;
  } finally {
    registerButton.disabled = false;
    await showState();
  }
});

showState().catch((error) => {
  console.error('[sso-touchid-gate] 状態の取得に失敗', error);
  state.textContent = `状態を取得できませんでした: ${error.message}`;
});
