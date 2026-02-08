/* global module */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MLCDebatePromptUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function findLastIndexByRole(messages, role) {
    if (!Array.isArray(messages) || messages.length === 0) return -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i] && messages[i].role === role) return i;
    }
    return -1;
  }

  function findLastIndexByAgentId(messages, agentId) {
    const key = typeof agentId === 'string' ? agentId.trim() : '';
    if (!key) return -1;
    if (!Array.isArray(messages) || messages.length === 0) return -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || typeof message !== 'object') continue;
      if (message.agentId === key || message.sourceAgentId === key) return i;
    }
    return -1;
  }

  function formatTranscriptForPrompt(messages, { roleLabelFn, maxChars = 48000 } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const blocks = [];
    const labelForRole = typeof roleLabelFn === 'function'
      ? roleLabelFn
      : (role) => String(role || 'Assistant');

    for (const message of messages) {
      if (!message) continue;
      const role = labelForRole(message.role, message);
      const content = String(message.content || '').trim();
      if (!content) continue;
      blocks.push(`${role}:\n${content}`);
    }

    if (blocks.length === 0) return '';
    let text = blocks.join('\n\n');
    if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
      text = `…(earlier messages omitted)\n\n${text.slice(text.length - maxChars)}`;
    }
    return text;
  }

  function buildMultiProviderDebatePrompt({
    header,
    roundIndex,
    rounds,
    expectedAgentId,
    expectedProvider,
    messages,
    roleLabelFn,
    userMessageOverride,
    instruction,
    maxChars = 48000
  } = {}) {
    const safeHeader = String(header || '').trim();
    const safeInstruction = String(instruction || '').trim();
    const safeMessages = Array.isArray(messages) ? messages : [];

    const lastOwnIndexByAgent = expectedAgentId ? findLastIndexByAgentId(safeMessages, expectedAgentId) : -1;
    const lastOwnIndexByProvider = expectedProvider ? findLastIndexByRole(safeMessages, expectedProvider) : -1;
    const lastOwnIndex = lastOwnIndexByAgent >= 0 ? lastOwnIndexByAgent : lastOwnIndexByProvider;
    const rawDelta = safeMessages.slice(Math.max(0, lastOwnIndex + 1));
    const delta = rawDelta.map((message) => {
      if (!message) return null;
      if (message.role !== 'user') return message;
      const override = String(userMessageOverride || '').trim();
      if (!override) return message;
      return { ...message, content: override };
    }).filter(Boolean);

    const deltaText = formatTranscriptForPrompt(delta, { roleLabelFn, maxChars }).trim();
    const safeRoundIndex = Number.isFinite(roundIndex) ? Math.max(1, Math.floor(roundIndex)) : 1;
    const safeRounds = Number.isFinite(rounds) ? Math.max(1, Math.floor(rounds)) : 1;

    const blocks = [];
    if (safeHeader) blocks.push(safeHeader);

    blocks.push('');
    blocks.push(`Iteration ${safeRoundIndex}/${safeRounds}`);
    blocks.push('');
    blocks.push(lastOwnIndex < 0 ? 'Conversation so far:' : 'New messages since your last turn:');
    blocks.push(deltaText || '[No new messages]');
    if (safeInstruction) {
      blocks.push('');
      blocks.push(safeInstruction);
    }

    return blocks.join('\n').trim();
  }

  return {
    findLastIndexByRole,
    findLastIndexByAgentId,
    formatTranscriptForPrompt,
    buildMultiProviderDebatePrompt
  };
});
