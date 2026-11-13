import { isUnlockableUrl, loadRules } from './config.js';
import { loadCredential, onCredentialChanged, registerCredential, requestAssertion } from './webauthn.js';

const target = new URLSearchParams(location.search).get('target') ?? '';
const unlockButton = document.getElementById('unlock');
const registerButton = document.getElementById('register');
const status = document.getElementById('status');

const NOT_REGISTERED_MESSAGE = 'Touch ID が未登録です。登録すると、続けて本人確認をして、この URL を開きます。';

document.getElementById('target').textContent = target;

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'バックグラウンドから応答がありません');
  return response;
}

// 登録済みなら「開く」だけ、未登録なら「登録して開く」だけを出す。
function showButtonsFor(credential) {
  unlockButton.hidden = !credential;
  registerButton.hidden = Boolean(credential);
  (credential ? unlockButton : registerButton).focus();
}

function setBusy(isBusy) {
  unlockButton.disabled = isBusy;
  registerButton.disabled = isBusy;
}

async function unlockWith(credential) {
  const { challenge } = await sendToBackground({ type: 'challenge' });
  const assertion = await requestAssertion(credential.credentialId, challenge);
  await sendToBackground({ type: 'unlock', assertion, target });
}

unlockButton.addEventListener('click', async () => {
  setBusy(true);
  status.textContent = 'Touch ID を待っています…';
  try {
    const credential = await loadCredential();
    // 別のタブで登録を消した場合など。未登録は異常ではないので、エラーとして記録しない。
    if (!credential) {
      showButtonsFor(null);
      status.textContent = NOT_REGISTERED_MESSAGE;
      return;
    }
    await unlockWith(credential);
    status.textContent = '確認できました。移動します。';
  } catch (error) {
    console.error('[url-gate] 解除に失敗', error);
    status.textContent = `開けませんでした: ${error.message}`;
  } finally {
    setBusy(false);
  }
});

// 登録したら、そのまま本人確認をして元の URL へ進む。
// 登録だけでは解除しない。解除はこれまでどおり、バックグラウンドが発行したチャレンジへの署名を検証してから行う。
registerButton.addEventListener('click', async () => {
  setBusy(true);
  status.textContent = 'Touch ID を登録しています…';
  let credential;
  try {
    credential = await registerCredential();
  } catch (error) {
    console.error('[url-gate] 登録に失敗', error);
    status.textContent = `登録できませんでした: ${error.message}`;
    setBusy(false);
    return;
  }

  showButtonsFor(credential);
  status.textContent = '登録しました。続けて Touch ID で本人確認をします…';
  try {
    await unlockWith(credential);
    status.textContent = '確認できました。移動します。';
  } catch (error) {
    console.error('[url-gate] 登録後の解除に失敗', error);
    status.textContent = `登録はできましたが、開けませんでした: ${error.message}。「Touch ID で開く」を押してください。`;
  } finally {
    setBusy(false);
  }
});

async function initialize() {
  if (!isUnlockableUrl(target, await loadRules())) {
    status.textContent = '遷移先が対象 URL ではないため、開けません。';
    return;
  }

  showButtonsFor(await loadCredential());
  if (unlockButton.hidden) status.textContent = NOT_REGISTERED_MESSAGE;

  // 設定ページなど別のタブで登録した場合も、ボタンを切り替える。
  onCredentialChanged((credential) => {
    if (unlockButton.disabled) return;
    showButtonsFor(credential);
    status.textContent = credential ? '' : NOT_REGISTERED_MESSAGE;
  });
}

initialize().catch((error) => {
  console.error('[url-gate] ゲートページの準備に失敗', error);
  status.textContent = `登録状態を取得できませんでした: ${error.message}`;
});
