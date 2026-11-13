// 実行: node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRules, convertLegacySettings, isGatedUrl, isUnlockableUrl, parseLine, parseLines } from '../config.js';
import { AWS_IAM_IDENTITY_CENTER } from '../presets.js';

const rulesOf = (...lines) => buildRules({ lines });
const blockedByNetwork = (rules, url, { isFrame }) => {
  const networkUrl = url.split('#')[0];
  const isBlocked = rules.gates.some(
    (gate) => (isFrame || gate.blocksAllRequests) && new RegExp(gate.pattern, 'i').test(networkUrl),
  );
  const isExcepted = isFrame && rules.exceptions.some((exception) => new RegExp(exception.pattern).test(networkUrl));
  return isBlocked && !isExcepted;
};

test('対象 URL はパスの前方一致で、大文字と小文字を区別しない', () => {
  const rules = rulesOf('example.com/admin');
  for (const url of ['https://example.com/admin', 'http://example.com/admin/users?x=1', 'https://example.com/ADMIN']) {
    assert.equal(isGatedUrl(url, rules), true, url);
    assert.equal(blockedByNetwork(rules, url, { isFrame: true }), true, url);
  }
  for (const url of ['https://example.com/', 'https://example.com.evil.test/admin', 'https://evil.test/?example.com/admin']) {
    assert.equal(isGatedUrl(url, rules), false, url);
    assert.equal(blockedByNetwork(rules, url, { isFrame: true }), false, url);
  }
});

test('all: を付けた対象 URL だけ、ページ内の通信も止める', () => {
  const rules = rulesOf('example.com/admin', 'all:api.example.com/token');
  assert.equal(blockedByNetwork(rules, 'https://api.example.com/token/new', { isFrame: false }), true);
  assert.equal(blockedByNetwork(rules, 'https://example.com/admin', { isFrame: false }), false);
  assert.equal(isGatedUrl('https://api.example.com/token', rules), true);
});

test('all というホストは、スキームを付ければ書ける', () => {
  assert.deepEqual(
    { kind: parseLine('http://all:8080/x').kind, hostname: parseLine('http://all:8080/x').hostname },
    { kind: 'gate', hostname: 'all' },
  );
  assert.equal(parseLine('all:example.com').blocksAllRequests, true);
  assert.equal(parseLine('http://all:8080/x').blocksAllRequests, false);
});

test('例外は完全一致で、Touch ID なしで開ける。ツールバーからの解除はできる', () => {
  const rules = rulesOf('example.com/admin', '!example.com/admin/help');
  assert.equal(isGatedUrl('https://example.com/admin/help', rules), false);
  assert.equal(isUnlockableUrl('https://example.com/admin/help', rules), true);
  assert.equal(blockedByNetwork(rules, 'https://example.com/admin/help', { isFrame: true }), false);
  for (const url of [
    'https://example.com/admin/help/more',
    'https://example.com/admin/help?x=1',
    'https://example.com/admin/help#section',
    'https://example.com/admin/HELP',
    'https://example.com/admin',
  ]) {
    assert.equal(isGatedUrl(url, rules), true, url);
  }
  assert.equal(blockedByNetwork(rules, 'https://example.com/admin/help/more', { isFrame: true }), true);
  assert.equal(blockedByNetwork(rules, 'https://example.com/admin/HELP', { isFrame: true }), true);
});

test('例外は # 以降まで比べる。* でまとめて外せる', () => {
  const rules = rulesOf('app.example.com', '!app.example.com/#/list', '!app.example.com/public/*');
  assert.equal(isGatedUrl('https://app.example.com/#/list', rules), false);
  assert.equal(isGatedUrl('https://app.example.com/#/settings', rules), true);
  assert.equal(isGatedUrl('https://app.example.com/', rules), true);
  assert.equal(isGatedUrl('https://app.example.com/public/a/b?c#d', rules), true);
  assert.equal(isGatedUrl('https://app.example.com/public/a/b?c', rules), false);

  const withAnyFragment = rulesOf('example.com/docs', '!example.com/docs/guide#*');
  assert.equal(isGatedUrl('https://example.com/docs/guide', withAnyFragment), false);
  assert.equal(isGatedUrl('https://example.com/docs/guide#install', withAnyFragment), false);
  assert.equal(isGatedUrl('https://example.com/docs/guide/x#install', withAnyFragment), true);
});

test('例外は対象 URL の外には効かず、all: の通信は外さない', () => {
  const rules = rulesOf('all:api.example.com', '!api.example.com/health', '!other.example.com/');
  assert.equal(isUnlockableUrl('https://other.example.com/', rules), false);
  assert.equal(isGatedUrl('https://api.example.com/health', rules), false);
  assert.equal(blockedByNetwork(rules, 'https://api.example.com/health', { isFrame: false }), true);
});

test('# 以降は例外にだけ書ける', () => {
  assert.throws(() => parseLine('example.com/#/x'), /フラグメント/);
  assert.equal(parseLine('!example.com/#/x').fragment, '#/x');
  assert.equal(parseLine('!example.com/a#').fragment, '');
});

test('入力の検証: コメントと空行は残し、重複した行は除き、誤りは行ごとに返す', () => {
  const { lines, errors } = parseLines(['', '# メモ', 'example.com', '', '', 'example.com', 'bad host/', '!example.com/x', '']);
  assert.deepEqual(lines, ['# メモ', 'example.com', '', '!example.com/x']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^bad host\//);
  assert.throws(() => parseLines([1]), /形式/);
});

test('解釈できない行が保存されていても、ほかの行は効く', (context) => {
  context.mock.method(console, 'error', () => {});
  const rules = rulesOf('bad host/', 'example.com');
  assert.equal(isGatedUrl('https://example.com/', rules), true);
});

test('AWS IAM Identity Center の例', () => {
  const rules = buildRules({ lines: AWS_IAM_IDENTITY_CENTER.lines });
  const free = [
    'https://d-1234567890.awsapps.com/start',
    'https://d-1234567890.awsapps.com/start/',
    'https://d-1234567890.awsapps.com/start/#/',
    'https://d-1234567890.awsapps.com/start/#/?tab=accounts',
    'https://d-1234567890.awsapps.com/start/#/?tab=applications',
    'https://ssoins-1.portal.us-east-1.app.aws/',
    'https://ssoins-1.portal.us-east-1.app.aws/#/?tab=accounts',
    'https://a.us-east-1.portal.amazonaws.com/start/#/',
  ];
  const gated = [
    'https://d-1234567890.awsapps.com/start/#/console?account_id=1',
    'https://d-1234567890.awsapps.com/start/?x=1',
    'https://ssoins-1.portal.us-east-1.app.aws/#/console',
    'https://oidc.us-east-1.amazonaws.com/authorize?response_type=code',
    'https://oidc.ap-northeast-1.api.aws/authorize',
    'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD',
  ];
  for (const url of free) {
    assert.equal(isGatedUrl(url, rules), false, url);
    assert.equal(isUnlockableUrl(url, rules), true, url);
    assert.equal(blockedByNetwork(rules, url, { isFrame: true }), false, url);
  }
  for (const url of gated) assert.equal(isGatedUrl(url, rules), true, url);
  for (const url of [
    'https://portal.sso.us-east-1.amazonaws.com/federation/console?account_id=1',
    'https://portal.sso.us-east-1.api.aws/federation/credentials',
    'https://oidc.us-east-1.amazonaws.com/device_authorization/associate_token',
  ]) {
    assert.equal(blockedByNetwork(rules, url, { isFrame: false }), true, url);
  }
  assert.equal(blockedByNetwork(rules, 'https://portal.sso.us-east-1.amazonaws.com/instance/appinstances', { isFrame: false }), false);
  assert.equal(isUnlockableUrl('https://console.aws.amazon.com/', rules), false);
});

test('0.3 までの設定は、同じ内容の行に直す', () => {
  const withPreset = convertLegacySettings({ awsPreset: true, customPatterns: ['example.com/admin*'] });
  assert.deepEqual(withPreset.lines, [...AWS_IAM_IDENTITY_CENTER.lines, '', 'example.com/admin*']);
  assert.deepEqual(convertLegacySettings({ awsPreset: false, customPatterns: ['example.com'] }).lines, ['example.com']);
  // 0.3 までは、設定を保存していなくても AWS の対象 URL が有効だった。
  assert.deepEqual(convertLegacySettings(undefined).lines, AWS_IAM_IDENTITY_CENTER.lines);
  assert.deepEqual(parseLines(withPreset.lines).errors, []);
});

test('0.3 までに追加した URL パターンと重なる AWS の例外は、移し替えない', () => {
  const urls = {
    ownPortalList: 'https://d-1234567890.awsapps.com/start/#/',
    otherPortalList: 'https://ssoins-1.portal.us-east-1.app.aws/#/?tab=accounts',
  };
  const gatedAfterMigration = (customPatterns) => {
    const rules = buildRules(convertLegacySettings({ awsPreset: true, customPatterns }));
    return Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, isGatedUrl(url, rules)]));
  };
  // 0.3 では、追加した URL パターンが一覧画面の例外より優先だった。
  for (const pattern of ['*.awsapps.com/start', 'd-1234567890.awsapps.com', '*.com/START/*', 'https://*awsapps.com:443/st*']) {
    assert.deepEqual(gatedAfterMigration([pattern]), { ownPortalList: true, otherPortalList: false }, pattern);
  }
  for (const pattern of ['example.com/admin*', 'awsapps.com.example.com', '*.awsapps.com/start/x', 'd-1.awsapps.com/other']) {
    assert.deepEqual(gatedAfterMigration([pattern]), { ownPortalList: false, otherPortalList: false }, pattern);
  }
});

test('0.3 までの「all というホスト + ポート」のパターンは、移し替えても同じ URL を指す', () => {
  const settings = convertLegacySettings({ awsPreset: false, customPatterns: ['all:8080/admin', 'example.com'] });
  assert.deepEqual(settings.lines, ['http://all:8080/admin', 'example.com']);
  const rules = buildRules(settings);
  assert.equal(isGatedUrl('https://all:8080/admin/x', rules), true);
  assert.equal(rules.gates.some((gate) => gate.blocksAllRequests), false);
});
