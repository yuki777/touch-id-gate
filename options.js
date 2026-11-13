import { loadSettings, onSettingsChanged, parseLines } from './config.js';
import { PRESETS } from './presets.js';
import { loadCredential, registerCredential, requestAssertion } from './webauthn.js';

const state = document.getElementById('state');
const status = document.getElementById('status');
const registerButton = document.getElementById('register');
const linesInput = document.getElementById('lines');
const saveButton = document.getElementById('save');
const settingsStatus = document.getElementById('settings-status');

async function showState() {
  const credential = await loadCredential();
  state.textContent = credential
    ? '登録済みです。登録し直すと、以前の登録は使えなくなります。'
    : '未登録です。登録するまで対象 URL は開けず、設定も保存できません。';
  registerButton.textContent = credential ? 'Touch ID を登録し直す' : 'Touch ID を登録する';
}

function showSettings(settings) {
  linesInput.value = settings.lines.join('\n');
}

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'バックグラウンドから応答がありません');
  return response;
}

// 例の行を、対象 URL の欄の末尾に足す。すでに書いてある行は足さない。保存するまで反映されない。
// 書きかけの行を消さないように、いま書いてある内容には手を付けない。
function addPreset(preset) {
  const current = linesInput.value.trimEnd();
  const existing = new Set(current.split('\n').map((line) => line.trim()));
  const additions = preset.lines
    .filter((line) => line === '' || !existing.has(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (additions === '') {
    settingsStatus.textContent = `${preset.name} の例は、すでに入っています。`;
    return;
  }
  linesInput.value = current === '' ? additions : `${current}\n\n${additions}`;
  settingsStatus.textContent = `${preset.name} の例を追加しました。「Touch ID で保存する」を押すと反映されます。`;
}

document.getElementById('presets').append(
  ...PRESETS.map((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `例を追加: ${preset.name}`;
    button.addEventListener('click', () => addPreset(preset));
    return button;
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

// 保存はバックグラウンドが Touch ID の署名を検証してから行う。
saveButton.addEventListener('click', async () => {
  const { lines, errors } = parseLines(linesInput.value.split('\n'));
  if (errors.length > 0) {
    settingsStatus.textContent = `書き方が正しくない行があります: ${errors.join(' / ')}`;
    return;
  }

  saveButton.disabled = true;
  try {
    const credential = await loadCredential();
    if (!credential) {
      settingsStatus.textContent = '先に Touch ID を登録してください。';
      return;
    }
    settingsStatus.textContent = 'Touch ID を待っています…';
    const { challenge } = await sendToBackground({ type: 'challenge' });
    const assertion = await requestAssertion(credential.credentialId, challenge);
    await sendToBackground({
      type: 'saveSettings',
      assertion,
      settings: { lines },
    });
    settingsStatus.textContent = '保存しました。';
  } catch (error) {
    console.error('[touch-id-gate] 設定の保存に失敗', error);
    settingsStatus.textContent = `保存できませんでした: ${error.message}`;
  } finally {
    saveButton.disabled = false;
  }
});

// 保存した内容（重複を除いたもの）や、別のタブで保存した内容を表示し直す。
onSettingsChanged(showSettings);

showState().catch((error) => {
  console.error('[touch-id-gate] 状態の取得に失敗', error);
  state.textContent = `状態を取得できませんでした: ${error.message}`;
});

loadSettings()
  .then(showSettings)
  .catch((error) => {
    console.error('[touch-id-gate] 設定の取得に失敗', error);
    settingsStatus.textContent = `設定を取得できませんでした: ${error.message}`;
  });
