const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function loadHelpers() {
  const context = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);

  const providersPath = path.resolve(__dirname, '../src/shared/providers.js');
  const helpersPath = path.resolve(__dirname, '../src/background/session-helpers.js');
  vm.runInContext(fs.readFileSync(providersPath, 'utf8'), context, { filename: providersPath });
  vm.runInContext(fs.readFileSync(helpersPath, 'utf8'), context, { filename: helpersPath });

  return context.mlcBackgroundSessionHelpers;
}

const helpers = loadHelpers();

runTest('session helpers are loaded', () => {
  assert.ok(helpers && typeof helpers === 'object');
  assert.equal(typeof helpers.sanitizeUiRoute, 'function');
  assert.equal(typeof helpers.getSessionParticipants, 'function');
  assert.equal(typeof helpers.normalizeChatDeliveryState, 'function');
});

runTest('sanitizeUiRoute normalizes debate agents and rounds', () => {
  const route = helpers.sanitizeUiRoute({
    kind: 'debate',
    rounds: 5,
    agents: [
      { provider: 'chatgpt', profileId: 'default' },
      { provider: 'gemini', profileId: 'profile_123' }
    ]
  });
  assert.equal(route.kind, 'debate');
  assert.equal(route.rounds, 5);
  assert.equal(route.agents.length, 2);
  assert.equal(route.providers.join(','), 'chatgpt,gemini');
});

runTest('getSessionParticipants supports duplicate provider labels', () => {
  const participants = helpers.getSessionParticipants({
    mode: 'debate',
    route: {
      agents: [
        { id: 'a', provider: 'chatgpt', label: 'ChatGPT #1' },
        { id: 'b', provider: 'chatgpt', label: 'ChatGPT #2' },
        { id: 'c', provider: 'gemini' }
      ]
    },
    agentProfileIds: { a: 'profile_a', b: 'profile_b', c: 'profile_c' },
    agentTabIds: { a: 11, b: 12, c: 13 },
    profileIds: { chatgpt: 'default_chatgpt', gemini: 'default_gemini' },
    tabIds: { chatgpt: 99, gemini: 98 }
  });

  assert.equal(participants.length, 3);
  assert.equal(participants[0].agentId, 'a');
  assert.equal(participants[1].agentId, 'b');
  assert.equal(participants[2].provider, 'gemini');
  assert.equal(participants[0].label, 'ChatGPT #1');
  assert.equal(participants[1].label, 'ChatGPT #2');
});

runTest('getRoundIndex uses participant count for debate', () => {
  const session = {
    mode: 'debate',
    participants: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }]
  };
  assert.equal(helpers.getRoundIndex(1, session), 1);
  assert.equal(helpers.getRoundIndex(3, session), 1);
  assert.equal(helpers.getRoundIndex(4, session), 2);
});

runTest('normalizeChatDeliveryState supports legacy shape and context check', () => {
  const normalized = helpers.normalizeChatDeliveryState({ chatgpt: 5, gemini: 2 });
  assert.equal(normalized.providers.chatgpt.deliveredUpTo, 5);
  assert.equal(normalized.providers.gemini.deliveredUpTo, 2);
  normalized.providers.chatgpt.contextKey = 'tab:42';

  assert.equal(helpers.getEffectiveDeliveredUpTo(normalized, 'chatgpt', 'tab:42'), 5);
  assert.equal(helpers.getEffectiveDeliveredUpTo(normalized, 'chatgpt', 'tab:999'), 0);
});
