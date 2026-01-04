const assert = require('assert');

const CaptureUtils = require('../captureUtils.js');

function runTest(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

runTest('looksLikeReferenceList: detects Sources heading + url list', () => {
  const text = [
    'Sources',
    '- https://example.com/a',
    '- https://example.org/b',
    '- https://example.net/c'
  ].join('\n');
  assert.strictEqual(CaptureUtils.looksLikeReferenceList(text, { provider: 'chatgpt' }), true);
});

runTest('looksLikeReferenceList: detects +N list pattern', () => {
  const text = [
    'Title one',
    'Title two',
    '+3',
    'Title three',
    'Title four'
  ].join('\n');
  assert.strictEqual(CaptureUtils.looksLikeReferenceList(text, { provider: 'chatgpt' }), true);
});

runTest('looksLikeReferenceList: does not flag normal prose with a Sources section', () => {
  const text = [
    'Here is an answer with a sentence.',
    '',
    'Sources:',
    '- https://example.com/a'
  ].join('\n');
  assert.strictEqual(CaptureUtils.looksLikeReferenceList(text, { provider: 'chatgpt' }), false);
});

runTest('chooseBestTextCandidate: prefers answer over sources-only list (even when sources longer)', () => {
  const answer = [
    'This is the real answer.',
    'It contains multiple sentences and explanation.',
    'It should be preferred over a sources-only block.'
  ].join('\n');

  const sourcesOnly = [
    'Sources',
    '- https://example.com/a',
    '- https://example.org/b',
    '- https://example.net/c',
    '- https://example.edu/d',
    '- https://example.io/e'
  ].join('\n');

  const result = CaptureUtils.chooseBestTextCandidate([sourcesOnly, answer], { provider: 'chatgpt' });
  assert.strictEqual(result.bestIndex, 1);
});

runTest('chooseBestTextCandidate: returns sources list when it is the only candidate', () => {
  const sourcesOnly = [
    'Sources',
    '- https://example.com/a',
    '- https://example.org/b'
  ].join('\n');

  const result = CaptureUtils.chooseBestTextCandidate([sourcesOnly], { provider: 'chatgpt' });
  assert.strictEqual(result.bestIndex, 0);
});

