# PLANv3.md - Multi-Agent System Implementation

## Current State Analysis

After reviewing the codebase, I understand your Chrome extension currently implements:

1. **Bidirectional Forwarding**: Users can toggle between ChatGPT ↔ Gemini message forwarding
2. **Response Capture**: The system captures responses from both LLMs and creates follow-up prompts
3. **Auto Follow-up**: When a message is sent from ChatGPT to Gemini, Gemini's response gets sent back to ChatGPT with a prompt asking ChatGPT to compare responses

## Proposed Multi-Agent System Enhancement

### Concept
Transform the current bidirectional forwarding into a structured multi-agent conversation system where:

1. **Initial Setup**: User defines they're entering a multi-agent mode with specified iterations
2. **Structured Conversation**: Each message includes context about the multi-agent system and current iteration
3. **Turn Management**: System alternates between ChatGPT and Gemini for specified number of iterations
4. **Context Preservation**: Each exchange includes the full conversation context

### Detailed Implementation Plan

#### Phase 1: Core Multi-Agent State Management

**File: `background.js`**

1. **New State Structure**:
```javascript
const multiAgentState = {
    isActive: false,
    maxIterations: 3,
    currentIteration: 0,
    currentTurnLLM: 'chatgpt', // who should respond next
    originalPrompt: '',
    originalSourceLLM: '', // where it started
    conversationHistory: [], // array of {llm: 'chatgpt'|'gemini', content: '...', iteration: 1}
    originalTabId: null,
    waitingForResponse: false,
    sessionId: null // unique ID for this multi-agent session
};
```

2. **Enhanced Message Types**:
   - `START_MULTI_AGENT_SESSION`: Initialize multi-agent mode
   - `MULTI_AGENT_RESPONSE_CAPTURED`: Enhanced response capture
   - `MULTI_AGENT_TURN_COMPLETE`: Signal turn completion

#### Phase 2: User Interface Enhancements

**File: `popup.js` and `popup.html`**

1. **New UI Controls**:
   - Toggle for "Multi-Agent Mode"
   - Iteration counter input (default: 3)
   - Current session status display
   - Stop session button

2. **Enhanced Prompt Template**:
```
You're in a multi-agent system where ChatGPT will talk first, then Gemini for {X} iterations.

Current Status: Iteration {current}/{max}, {current_llm}'s turn

Original User Question: {original_prompt}

Previous Exchanges:
{conversation_history}

Now respond as {current_llm}. Be constructive, collaborative, and critical. Don't just agree - add value, challenge assumptions, or provide new perspectives.
```

#### Phase 3: Content Script Enhancements

**File: `contentScript.js`**

1. **Multi-Agent Toggle Button**:
   - New button alongside existing forward toggles
   - "🤖 Multi-Agent (3x)" button that shows current iteration status
   - Visual indicator of active multi-agent session

2. **Enhanced Response Capture**:
   - Include iteration number and conversation context
   - Better response completion detection
   - Structured response formatting

#### Phase 4: Core Logic Implementation

**File: `background.js` - New Functions**

1. **`initializeMultiAgentSession(originalPrompt, sourceLLM, maxIterations)`**:
   - Reset multi-agent state
   - Set initial parameters
   - Generate session ID
   - Send initial formatted prompt

2. **`handleMultiAgentResponse(response, sourceLLM)`**:
   - Add response to conversation history
   - Determine next LLM turn
   - Format next prompt with full context
   - Check if session should continue or end

3. **`formatMultiAgentPrompt(targetLLM, iteration, originalPrompt, history)`**:
   - Create structured prompt with full context
   - Include conversation history
   - Add iteration and role information

4. **`sendMultiAgentTurn(targetLLM, formattedPrompt)`**:
   - Send to appropriate LLM with context
   - Track waiting state
   - Handle errors and timeouts

#### Phase 5: Conversation Flow Logic

```
User Input (with Multi-Agent enabled):
├── Initialize Session (iteration 1/3, ChatGPT's turn)
├── Send formatted prompt to ChatGPT with context
├── Wait for ChatGPT response
├── Capture response → Add to history
├── Format prompt for Gemini (iteration 1/3, Gemini's turn)
├── Send to Gemini with full context
├── Wait for Gemini response
├── Capture response → Add to history
├── Check if max iterations reached
├── If not: Continue to next iteration
└── If yes: End session, show summary
```

#### Phase 6: Advanced Features

1. **Session Management**:
   - Pause/resume sessions
   - Export conversation history
   - Template customization

2. **Intelligent Turn Management**:
   - Dynamic iteration count based on conversation quality
   - Conflict resolution when both LLMs disagree
   - Summary generation at session end

3. **Enhanced UI**:
   - Live conversation view in side panel
   - Progress indicator
   - Conversation export functionality

### Implementation Priority

**High Priority (Core MVP)**:
1. Multi-agent state management in background.js
2. Enhanced message formatting with iteration context
3. Basic UI controls for enabling multi-agent mode
4. Core conversation flow (fixed 3 iterations)

**Medium Priority**:
1. Visual indicators and status updates
2. Session management (start/stop/pause)
3. Conversation history display
4. Error handling and recovery

**Low Priority (Future Enhancements)**:
1. Dynamic iteration count
2. Conversation export
3. Template customization
4. Advanced analytics

### Technical Considerations

1. **State Persistence**: Multi-agent sessions should survive page refreshes
2. **Error Recovery**: Handle cases where one LLM doesn't respond
3. **Performance**: Minimize DOM queries and optimize response capture
4. **User Experience**: Clear visual feedback on session progress
5. **Compatibility**: Maintain existing bidirectional forwarding functionality

### Risk Mitigation

1. **DOM Changes**: Both ChatGPT and Gemini UIs change frequently - implement robust selector fallbacks
2. **Rate Limiting**: Avoid hitting LLM rate limits with rapid exchanges
3. **User Confusion**: Clear UI to distinguish between regular forwarding and multi-agent mode
4. **Memory Usage**: Clean up conversation history for long sessions

### Testing Strategy

1. **Unit Tests**: State management and message formatting logic
2. **Integration Tests**: Full multi-agent conversation flows
3. **UI Tests**: User interface interactions and feedback
4. **Edge Cases**: Network failures, tab closures, rapid user inputs

### Success Metrics

1. **Functionality**: Successfully complete 3-iteration conversations
2. **Reliability**: Handle edge cases without breaking
3. **User Experience**: Intuitive interface and clear progress indication
4. **Performance**: Fast response times and minimal resource usage

This plan transforms your current bidirectional system into a sophisticated multi-agent conversation orchestrator while maintaining the existing functionality as a fallback option.