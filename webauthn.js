const CREDENTIAL_STORAGE_KEY = 'credential';
const ES256_ALGORITHM = -7;
const RP_ID_HASH_LENGTH = 32;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const P256_COORDINATE_LENGTH = 32;
const CHALLENGE_LENGTH = 32;
const REQUEST_TIMEOUT_MS = 60_000;

export function toBase64Url(buffer) {
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomChallenge() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(CHALLENGE_LENGTH)));
}

export async function loadCredential() {
  const stored = await chrome.storage.local.get(CREDENTIAL_STORAGE_KEY);
  return stored[CREDENTIAL_STORAGE_KEY] ?? null;
}

// 拡張ページから呼ぶ。RP ID は指定せず、既定値（拡張 ID）に任せる。
export async function registerCredential() {
  const created = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'SSO Touch ID Gate' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'sso-touchid-gate',
        displayName: 'SSO Touch ID Gate',
      },
      challenge: fromBase64Url(randomChallenge()),
      pubKeyCredParams: [{ type: 'public-key', alg: ES256_ALGORITHM }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      attestation: 'none',
      timeout: REQUEST_TIMEOUT_MS,
    },
  });
  if (created.response.getPublicKeyAlgorithm() !== ES256_ALGORITHM) {
    throw new Error('認証器が ES256 以外の鍵を返しました');
  }
  const credential = {
    credentialId: toBase64Url(created.rawId),
    publicKeySpki: toBase64Url(created.response.getPublicKey()),
  };
  await chrome.storage.local.set({ [CREDENTIAL_STORAGE_KEY]: credential });
  return credential;
}

export async function requestAssertion(credentialId, challenge) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(challenge),
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
      userVerification: 'required',
      timeout: REQUEST_TIMEOUT_MS,
    },
  });
  return {
    authenticatorData: toBase64Url(assertion.response.authenticatorData),
    clientDataJSON: toBase64Url(assertion.response.clientDataJSON),
    signature: toBase64Url(assertion.response.signature),
  };
}

// WebAuthn の署名は ASN.1 DER、WebCrypto は r||s の固定長を要求するので変換する。
function derSignatureToRaw(der) {
  let offset = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const readInteger = () => {
    if (der[offset] !== 0x02) throw new Error('署名の形式が不正です');
    const length = der[offset + 1];
    const start = offset + 2;
    const end = start + length;
    if (end > der.length) throw new Error('署名の形式が不正です');
    offset = end;
    let value = der.subarray(start, end);
    while (value.length > P256_COORDINATE_LENGTH && value[0] === 0) value = value.subarray(1);
    if (value.length > P256_COORDINATE_LENGTH) throw new Error('署名の形式が不正です');
    const padded = new Uint8Array(P256_COORDINATE_LENGTH);
    padded.set(value, P256_COORDINATE_LENGTH - value.length);
    return padded;
  };
  if (der[0] !== 0x30) throw new Error('署名の形式が不正です');
  const r = readInteger();
  const s = readInteger();
  return Uint8Array.from([...r, ...s]);
}

// 検証に失敗したら例外を投げる。成功時は何も返さない。
async function matchesRpId(actualRpIdHash, rpId) {
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  return actualRpIdHash.length === RP_ID_HASH_LENGTH && expected.every((byte, index) => byte === actualRpIdHash[index]);
}

export async function verifyAssertion({ publicKeySpki, assertion, expectedChallenge, expectedOrigin, acceptedRpIds }) {
  const authenticatorData = fromBase64Url(assertion.authenticatorData);
  const clientDataBytes = fromBase64Url(assertion.clientDataJSON);
  const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));

  if (clientData.type !== 'webauthn.get') throw new Error('認証の種別が不正です');
  if (clientData.challenge !== expectedChallenge) throw new Error('チャレンジが一致しません');
  if (clientData.origin !== expectedOrigin) throw new Error('オリジンが一致しません');

  const actualRpIdHash = authenticatorData.subarray(0, RP_ID_HASH_LENGTH);
  const rpIdMatches = await Promise.all(acceptedRpIds.map((rpId) => matchesRpId(actualRpIdHash, rpId)));
  if (!rpIdMatches.includes(true)) throw new Error('RP ID が一致しません');

  const flags = authenticatorData[RP_ID_HASH_LENGTH];
  if (!(flags & FLAG_USER_PRESENT) || !(flags & FLAG_USER_VERIFIED)) {
    throw new Error('本人確認（Touch ID）が行われていません');
  }

  const publicKey = await crypto.subtle.importKey(
    'spki',
    fromBase64Url(publicKeySpki),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));
  const signedData = Uint8Array.from([...authenticatorData, ...clientDataHash]);
  const isValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    derSignatureToRaw(fromBase64Url(assertion.signature)),
    signedData,
  );
  if (!isValid) throw new Error('署名が不正です');
}
