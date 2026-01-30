const assert = require('assert');

const DebatePromptUtils = require('../debatePromptUtils.js');

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

function roleLabel(role, message) {
  const agentLabel = message && typeof message.agentLabel === 'string' ? message.agentLabel.trim() : '';
  if (agentLabel) return agentLabel;
  const key = String(role || '').toLowerCase();
  if (key === 'user') return 'User';
  if (key === 'chatgpt') return 'ChatGPT';
  if (key === 'claude') return 'Claude';
  if (key === 'gemini') return 'Gemini';
  if (key === 'grok') return 'Grok';
  return role || 'Assistant';
}

runTest('multi-provider: round1 prompts include all prior turns', () => {
  const header = 'HEADER';
  const instruction = 'INSTRUCTION';
  const rounds = 2;

  const user = { role: 'user', content: 'U' };
  const g1 = { role: 'chatgpt', content: 'G1' };
  const c1 = { role: 'claude', content: 'C1' };

  const turn1 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 1,
    rounds,
    expectedProvider: 'chatgpt',
    messages: [user],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(turn1.includes('User:\nU'));
  assert.ok(!turn1.includes('ChatGPT:\nG1'));

  const turn2 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 1,
    rounds,
    expectedProvider: 'claude',
    messages: [user, g1],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(turn2.includes('User:\nU'));
  assert.ok(turn2.includes('ChatGPT:\nG1'));
  assert.ok(!turn2.includes('Claude:\nC1'));

  const turn3 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 1,
    rounds,
    expectedProvider: 'gemini',
    messages: [user, g1, c1],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(turn3.includes('User:\nU'));
  assert.ok(turn3.includes('ChatGPT:\nG1'));
  assert.ok(turn3.includes('Claude:\nC1'));
});

runTest('multi-provider: round2 prompts include only missing messages since last own answer', () => {
  const header = 'HEADER';
  const instruction = 'INSTRUCTION';
  const rounds = 2;

  const user = { role: 'user', content: 'U' };
  const g1 = { role: 'chatgpt', content: 'G1' };
  const c1 = { role: 'claude', content: 'C1' };
  const m1 = { role: 'gemini', content: 'M1' };
  const g2 = { role: 'chatgpt', content: 'G2' };
  const c2 = { role: 'claude', content: 'C2' };

  const chatgptTurn2 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 2,
    rounds,
    expectedProvider: 'chatgpt',
    messages: [user, g1, c1, m1],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(!chatgptTurn2.includes('User:\nU'));
  assert.ok(!chatgptTurn2.includes('ChatGPT:\nG1'));
  assert.ok(chatgptTurn2.includes('Claude:\nC1'));
  assert.ok(chatgptTurn2.includes('Gemini:\nM1'));

  const claudeTurn2 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 2,
    rounds,
    expectedProvider: 'claude',
    messages: [user, g1, c1, m1, g2],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(!claudeTurn2.includes('User:\nU'));
  assert.ok(!claudeTurn2.includes('Claude:\nC1'));
  assert.ok(claudeTurn2.includes('Gemini:\nM1'));
  assert.ok(claudeTurn2.includes('ChatGPT:\nG2'));

  const geminiTurn2 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 2,
    rounds,
    expectedProvider: 'gemini',
    messages: [user, g1, c1, m1, g2, c2],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(!geminiTurn2.includes('User:\nU'));
  assert.ok(!geminiTurn2.includes('Gemini:\nM1'));
  assert.ok(geminiTurn2.includes('ChatGPT:\nG2'));
  assert.ok(geminiTurn2.includes('Claude:\nC2'));
});

runTest('userMessageOverride replaces user content in transcript', () => {
  const prompt = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header: '',
    roundIndex: 1,
    rounds: 1,
    expectedProvider: 'chatgpt',
    messages: [{ role: 'user', content: 'RAW' }],
    roleLabelFn: roleLabel,
    userMessageOverride: 'WRAPPED',
    instruction: 'INSTRUCTION'
  });
  assert.ok(prompt.includes('User:\nWRAPPED'));
  assert.ok(!prompt.includes('User:\nRAW'));
});

runTest('multi-provider: supports 4 providers (delta size = N-1)', () => {
  const header = 'HEADER';
  const instruction = 'INSTRUCTION';
  const rounds = 2;

  const user = { role: 'user', content: 'U' };
  const g1 = { role: 'chatgpt', content: 'G1' };
  const c1 = { role: 'claude', content: 'C1' };
  const m1 = { role: 'gemini', content: 'M1' };
  const k1 = { role: 'grok', content: 'K1' };
  const g2 = { role: 'chatgpt', content: 'G2' };
  const c2 = { role: 'claude', content: 'C2' };
  const m2 = { role: 'gemini', content: 'M2' };

  const chatgptTurn2 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 2,
    rounds,
    expectedProvider: 'chatgpt',
    messages: [user, g1, c1, m1, k1],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(chatgptTurn2.includes('Claude:\nC1'));
  assert.ok(chatgptTurn2.includes('Gemini:\nM1'));
  assert.ok(chatgptTurn2.includes('Grok:\nK1'));
  assert.ok(!chatgptTurn2.includes('ChatGPT:\nG1'));

  const geminiTurn2 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 2,
    rounds,
    expectedProvider: 'gemini',
    messages: [user, g1, c1, m1, k1, g2, c2],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(geminiTurn2.includes('Grok:\nK1'));
  assert.ok(geminiTurn2.includes('ChatGPT:\nG2'));
  assert.ok(geminiTurn2.includes('Claude:\nC2'));
  assert.ok(!geminiTurn2.includes('Gemini:\nM1'));

  const grokTurn2 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 2,
    rounds,
    expectedProvider: 'grok',
    messages: [user, g1, c1, m1, k1, g2, c2, m2],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });
  assert.ok(grokTurn2.includes('ChatGPT:\nG2'));
  assert.ok(grokTurn2.includes('Claude:\nC2'));
  assert.ok(grokTurn2.includes('Gemini:\nM2'));
  assert.ok(!grokTurn2.includes('Grok:\nK1'));
});

runTest('multi-provider: supports duplicate provider agents via expectedAgentId', () => {
  const header = 'HEADER';
  const instruction = 'INSTRUCTION';
  const rounds = 2;

  const user = { role: 'user', content: 'U' };
  const g1a = { role: 'chatgpt', agentId: 'agent_a', agentLabel: 'ChatGPT #1', content: 'G1A' };
  const g1b = { role: 'chatgpt', agentId: 'agent_b', agentLabel: 'ChatGPT #2', content: 'G1B' };
  const m1 = { role: 'gemini', agentId: 'agent_c', agentLabel: 'Gemini', content: 'M1' };

  const chatgptAgentATurn2 = DebatePromptUtils.buildMultiProviderDebatePrompt({
    header,
    roundIndex: 2,
    rounds,
    expectedAgentId: 'agent_a',
    expectedProvider: 'chatgpt',
    messages: [user, g1a, g1b, m1],
    roleLabelFn: roleLabel,
    userMessageOverride: 'U',
    instruction
  });

  assert.ok(!chatgptAgentATurn2.includes('User:\nU'));
  assert.ok(!chatgptAgentATurn2.includes('ChatGPT #1:\nG1A'));
  assert.ok(chatgptAgentATurn2.includes('ChatGPT #2:\nG1B'));
  assert.ok(chatgptAgentATurn2.includes('Gemini:\nM1'));
});
