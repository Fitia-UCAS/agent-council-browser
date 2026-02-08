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

runTest('looksLikeReferenceList: detects Sources heading + title-only list', () => {
  const text = [
    'Sources',
    'Example report one',
    'Example report two',
    'Example report three',
    'Example report four'
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

runTest('looksLikeReferenceList: does not flag answer-like link list with intro line', () => {
  const text = [
    'Here are some links:',
    'https://example.com/a',
    'https://example.org/b',
    'https://example.net/c'
  ].join('\n');
  assert.strictEqual(CaptureUtils.looksLikeReferenceList(text, { provider: 'chatgpt' }), false);
});

runTest('chooseBestTextCandidate: prefers full link list answer over intro fragment', () => {
  const introOnly = 'Here are some links:';
  const full = [
    'Here are some links:',
    'https://example.com/a',
    'https://example.org/b',
    'https://example.net/c'
  ].join('\n');

  const result = CaptureUtils.chooseBestTextCandidate([introOnly, full], { provider: 'chatgpt' });
  assert.strictEqual(result.bestIndex, 1);
});

runTest('looksLikeUiControlText: detects Grok voice control label', () => {
  const text = 'Passer en mode vocal';
  assert.strictEqual(CaptureUtils.looksLikeUiControlText(text, { provider: 'grok' }), true);
});

runTest('chooseBestTextCandidate: Grok prefers answer over control-only label', () => {
  const controlOnly = 'Arrêter la réponse du modèle';
  const answer = [
    'Voici une réponse complète avec contexte.',
    'Elle contient plusieurs phrases et ne doit pas être traitée comme un bouton UI.'
  ].join('\n');
  const result = CaptureUtils.chooseBestTextCandidate([controlOnly, answer], { provider: 'grok' });
  assert.strictEqual(result.bestIndex, 1);
});

runTest('looksLikeUiControlText: detects Grok satisfaction footer line', () => {
  const text = "Are you satisfied with Grok's answer?";
  assert.strictEqual(CaptureUtils.looksLikeUiControlText(text, { provider: 'grok' }), true);
});

runTest('looksLikeUiControlText: detects Grok latency-only footer line', () => {
  const text = '773ms';
  assert.strictEqual(CaptureUtils.looksLikeUiControlText(text, { provider: 'grok' }), true);
});

runTest('looksLikePromptScaffoldText: detects Grok prompt scaffold line', () => {
  const text = "Here's a new message from the user:";
  assert.strictEqual(CaptureUtils.looksLikePromptScaffoldText(text, { provider: 'grok' }), true);
});

runTest('looksLikePromptScaffoldText: does not flag normal answer text', () => {
  const text = 'Voici une réponse complète avec plusieurs phrases utiles.';
  assert.strictEqual(CaptureUtils.looksLikePromptScaffoldText(text, { provider: 'grok' }), false);
});

runTest('chooseBestTextCandidate: Grok prefers answer over prompt scaffold', () => {
  const scaffold = [
    'Conversation so far:',
    "Here's a new message from the user:",
    'Please Grok answer....'
  ].join('\n');
  const answer = [
    'Salut.',
    "Voici la réponse finale avec suffisamment d'informations pour être utile."
  ].join('\n');
  const result = CaptureUtils.chooseBestTextCandidate([scaffold, answer], { provider: 'grok' });
  assert.strictEqual(result.bestIndex, 1);
});
