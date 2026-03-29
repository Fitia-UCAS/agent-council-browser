(function sessionEngineModule(globalScope) {
    'use strict';

    function normalizeMode(mode) {
        const key = String(mode || '')
            .trim()
            .toLowerCase();
        if (key === 'debate' || key === 'single' || key === 'direct' || key === 'parallel') {
            return key;
        }
        return 'debate';
    }

    function createSessionEngine({
        normalizeProviderKey,
        isSupportedProviderKey,
        formatProviderLabel,
        listSessionProviders,
    } = {}) {
        const normalizeProvider =
            typeof normalizeProviderKey === 'function'
                ? normalizeProviderKey
                : (value) =>
                      String(value || '')
                          .trim()
                          .toLowerCase();
        const isSupportedProvider =
            typeof isSupportedProviderKey === 'function' ? isSupportedProviderKey : () => true;
        const formatLabel =
            typeof formatProviderLabel === 'function'
                ? formatProviderLabel
                : (provider) => String(provider || '').trim() || 'Provider';
        const listProviders =
            typeof listSessionProviders === 'function'
                ? listSessionProviders
                : (session) => {
                      const out = [];
                      const push = (provider) => {
                          const key = normalizeProvider(provider);
                          if (!key || !isSupportedProvider(key) || out.includes(key)) return;
                          out.push(key);
                      };
                      push(session?.firstLLM);
                      push(session?.secondLLM);
                      return out;
                  };

        function getSessionParticipants(session) {
            if (Array.isArray(session?.participants) && session.participants.length > 0) {
                return session.participants;
            }
            const routeAgents = Array.isArray(session?.route?.agents) ? session.route.agents : null;
            if (routeAgents && routeAgents.length > 0) {
                return routeAgents
                    .map((agent, idx) => {
                        const provider = normalizeProvider(agent?.provider);
                        if (!provider || !isSupportedProvider(provider)) return null;
                        const agentId =
                            typeof agent?.id === 'string' && agent.id.trim()
                                ? agent.id.trim()
                                : `agent_${provider}_${idx + 1}`;
                        const profileId =
                            typeof session?.agentProfileIds?.[agentId] === 'string'
                                ? session.agentProfileIds[agentId]
                                : session?.profileIds?.[provider] || null;
                        const tabId = Number.isFinite(session?.agentTabIds?.[agentId])
                            ? session.agentTabIds[agentId]
                            : session?.tabIds?.[provider] || null;
                        const label =
                            typeof agent?.label === 'string' ? agent.label : formatLabel(provider);
                        return { agentId, provider, profileId, tabId, label };
                    })
                    .filter(Boolean);
            }
            const providers =
                Array.isArray(session?.route?.providers) && session.route.providers.length > 0
                    ? session.route.providers
                          .map(normalizeProvider)
                          .filter((p) => p && isSupportedProvider(p))
                    : listProviders(session);
            return providers
                .map((provider) => ({
                    agentId: provider,
                    provider,
                    profileId: session?.profileIds?.[provider] || null,
                    tabId: session?.tabIds?.[provider] || null,
                    label: formatLabel(provider),
                }))
                .filter(Boolean);
        }

        function getTurnParticipant(session, turnIndex) {
            const participants = getSessionParticipants(session);
            if (participants.length === 0) return null;
            const mode = normalizeMode(session?.mode);

            if (mode === 'parallel') {
                return participants[0] || null;
            }
            if (mode === 'direct') {
                if (participants.length >= 2) {
                    return turnIndex === 1 ? participants[0] : participants[1];
                }
                return participants[0] || null;
            }
            if (mode === 'single') {
                return participants[0] || null;
            }
            if (mode === 'debate') {
                const idx = Math.max(0, (turnIndex - 1) % participants.length);
                return participants[idx] || null;
            }
            return participants[0] || null;
        }

        function getTurnProvider(session, turnIndex) {
            const mode = normalizeMode(session?.mode);
            if (mode === 'parallel') {
                return session?.firstLLM || 'chatgpt';
            }
            if (mode === 'direct') {
                if (turnIndex === 1) return session?.firstLLM || 'chatgpt';
                return session?.secondLLM || session?.firstLLM || 'chatgpt';
            }
            if (mode === 'single') {
                return session?.firstLLM || 'chatgpt';
            }
            if (mode === 'debate') {
                const participant = getTurnParticipant(session, turnIndex);
                if (participant?.provider) return participant.provider;
            }
            return turnIndex % 2 === 1 ? session?.firstLLM : session?.secondLLM;
        }

        function getRoundIndex(turnIndex, session = null) {
            const mode = normalizeMode(session?.mode);
            if (mode === 'direct' || mode === 'parallel') {
                return 1;
            }
            if (mode === 'single') {
                return Math.max(1, turnIndex);
            }
            if (mode === 'debate') {
                const participants = getSessionParticipants(session);
                const divisor = participants.length >= 2 ? participants.length : 2;
                return Math.ceil(turnIndex / divisor);
            }
            return Math.ceil(turnIndex / 2);
        }

        function resolveResponseAgentId(message) {
            if (typeof message?.agentId === 'string' && message.agentId.trim()) {
                return message.agentId.trim();
            }
            if (typeof message?.sourceAgentId === 'string' && message.sourceAgentId.trim()) {
                return message.sourceAgentId.trim();
            }
            return null;
        }

        function validateSequentialResponse(session, message) {
            const expectedAgentId =
                typeof session?.waitingFor === 'string' && session.waitingFor.trim()
                    ? session.waitingFor.trim()
                    : null;
            const messageAgentId = resolveResponseAgentId(message);

            if (expectedAgentId && !messageAgentId) {
                return {
                    ok: false,
                    reason: 'missing_agent_id',
                    expectedAgentId,
                    messageAgentId,
                };
            }
            if (expectedAgentId && messageAgentId && messageAgentId !== expectedAgentId) {
                return {
                    ok: false,
                    reason: 'unexpected_agent_id',
                    expectedAgentId,
                    messageAgentId,
                };
            }

            const expectedTurnAttemptId =
                typeof session?.lastTurnAttemptId === 'string' && session.lastTurnAttemptId.trim()
                    ? session.lastTurnAttemptId.trim()
                    : null;
            const messageTurnAttemptId =
                typeof message?.turnAttemptId === 'string' && message.turnAttemptId.trim()
                    ? message.turnAttemptId.trim()
                    : null;
            if (expectedTurnAttemptId && messageTurnAttemptId) {
                if (messageTurnAttemptId !== expectedTurnAttemptId) {
                    return {
                        ok: false,
                        reason: 'turn_attempt_mismatch',
                        expectedTurnAttemptId,
                        messageTurnAttemptId,
                    };
                }
            }

            if (expectedTurnAttemptId && !messageTurnAttemptId) {
                return {
                    ok: false,
                    reason: 'missing_turn_attempt_id',
                    expectedTurnAttemptId,
                };
            }

            const expectedPromptId =
                typeof session?.lastPromptId === 'string' && session.lastPromptId.trim()
                    ? session.lastPromptId.trim()
                    : null;
            const messagePromptId =
                typeof message?.promptId === 'string' && message.promptId.trim()
                    ? message.promptId.trim()
                    : null;
            if (expectedPromptId && messagePromptId && messagePromptId !== expectedPromptId) {
                return {
                    ok: false,
                    reason: 'prompt_id_mismatch',
                    expectedPromptId,
                    messagePromptId,
                };
            }

            const parsedTurnIndex = Number.isFinite(message?.turnIndex)
                ? Number(message.turnIndex)
                : parseInt(message?.turnIndex, 10);
            const hasTurnIndex = Number.isFinite(parsedTurnIndex);
            if (hasTurnIndex && parsedTurnIndex !== session?.turnIndex) {
                return {
                    ok: false,
                    reason: 'turn_index_mismatch',
                    expectedTurnIndex: session?.turnIndex ?? null,
                    messageTurnIndex: parsedTurnIndex,
                };
            }

            if (!expectedTurnAttemptId && expectedPromptId && !messagePromptId) {
                return {
                    ok: false,
                    reason: 'missing_prompt_id',
                    expectedPromptId,
                };
            }

            if (!expectedTurnAttemptId && expectedPromptId && !hasTurnIndex) {
                return {
                    ok: false,
                    reason: 'missing_turn_index',
                    expectedTurnIndex: session?.turnIndex ?? null,
                };
            }

            return {
                ok: true,
                expectedAgentId,
                messageAgentId,
                expectedTurnAttemptId,
                messageTurnAttemptId,
                expectedPromptId,
                messagePromptId,
                messageTurnIndex: hasTurnIndex ? parsedTurnIndex : null,
            };
        }

        return {
            getRoundIndex,
            getSessionParticipants,
            getTurnParticipant,
            getTurnProvider,
            validateSequentialResponse,
        };
    }

    globalScope.MLCSessionEngine = {
        createSessionEngine,
    };
})(typeof self !== 'undefined' ? self : window);
