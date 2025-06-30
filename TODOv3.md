# TODOv3.md - Multi-Agent System Implementation Tasks

## Phase 1: Core Infrastructure (High Priority)

### 1.1 Background Script Multi-Agent State Management
- [ ] **Add multi-agent state structure to background.js**
  - [ ] Create `multiAgentState` object with session tracking
  - [ ] Add session ID generation function
  - [ ] Implement state reset and cleanup functions
  - [ ] Add conversation history management

- [ ] **Enhance message handling for multi-agent flows**
  - [ ] Add `START_MULTI_AGENT_SESSION` message handler
  - [ ] Add `MULTI_AGENT_RESPONSE_CAPTURED` message handler
  - [ ] Add `MULTI_AGENT_TURN_COMPLETE` message handler
  - [ ] Add `END_MULTI_AGENT_SESSION` message handler

- [ ] **Core multi-agent functions**
  - [ ] `initializeMultiAgentSession(prompt, sourceLLM, maxIterations)`
  - [ ] `handleMultiAgentResponse(response, sourceLLM, sessionId)`
  - [ ] `formatMultiAgentPrompt(targetLLM, iteration, history)`
  - [ ] `sendMultiAgentTurn(targetLLM, formattedPrompt, sessionId)`
  - [ ] `checkSessionComplete(sessionId)`

### 1.2 User Interface Controls
- [ ] **Update popup.html**
  - [ ] Add multi-agent mode toggle checkbox
  - [ ] Add iteration count input field (default: 3)
  - [ ] Add session status display area
  - [ ] Add stop/pause session buttons
  - [ ] Style new controls to match existing design

- [ ] **Update popup.js**
  - [ ] Add event handlers for multi-agent controls
  - [ ] Add session status update functions
  - [ ] Add validation for iteration count input
  - [ ] Integrate with existing send prompt logic
  - [ ] Add progress display functions

### 1.3 Content Script Enhancements
- [ ] **Add multi-agent toggle button to contentScript.js**
  - [ ] Create visual multi-agent toggle (🤖 Multi-Agent)
  - [ ] Add iteration counter display on button
  - [ ] Position button near existing toggle buttons
  - [ ] Add visual state indicators (active/inactive)

- [ ] **Enhance response capture for multi-agent**
  - [ ] Modify existing response capture to include session context
  - [ ] Add iteration tracking to response messages
  - [ ] Improve response completion detection
  - [ ] Add session-specific response formatting

## Phase 2: Core Logic Implementation (High Priority)

### 2.1 Conversation Flow Management
- [ ] **Prompt formatting system**
  - [ ] Create multi-agent prompt template
  - [ ] Add conversation history formatting
  - [ ] Add iteration and role context
  - [ ] Add collaborative instruction generation

- [ ] **Turn management logic**
  - [ ] Implement alternating LLM turn system
  - [ ] Add turn validation and error handling
  - [ ] Add timeout handling for unresponsive LLMs
  - [ ] Add session state persistence

### 2.2 Integration with Existing System
- [ ] **Modify existing forward prompt logic**
  - [ ] Detect when multi-agent mode is active
  - [ ] Route messages through multi-agent system when enabled
  - [ ] Maintain backward compatibility with simple forwarding
  - [ ] Add mode switching capabilities

- [ ] **Enhanced response processing**
  - [ ] Update response capture to handle multi-agent context
  - [ ] Add conversation history building
  - [ ] Add session continuation logic
  - [ ] Add session completion handling

## Phase 3: Advanced Features (Medium Priority)

### 3.1 Session Management
- [ ] **Session persistence**
  - [ ] Save session state to chrome.storage
  - [ ] Restore sessions after browser restart
  - [ ] Handle tab closure during sessions
  - [ ] Add session cleanup on extension reload

- [ ] **Session controls**
  - [ ] Add pause/resume functionality
  - [ ] Add session cancellation
  - [ ] Add session restart capabilities
  - [ ] Add manual session progression

### 3.2 Error Handling and Recovery
- [ ] **Robust error handling**
  - [ ] Handle LLM response failures
  - [ ] Add retry mechanisms for failed turns
  - [ ] Handle network connectivity issues
  - [ ] Add graceful degradation options

- [ ] **User feedback systems**
  - [ ] Add error notifications in popup
  - [ ] Add progress indicators
  - [ ] Add session status messages
  - [ ] Add troubleshooting guidance

## Phase 4: Testing and Validation (Medium Priority)

### 4.1 Functionality Testing
- [ ] **Core flow testing**
  - [ ] Test 3-iteration conversations (ChatGPT → Gemini → ChatGPT)
  - [ ] Test session initialization and cleanup
  - [ ] Test turn alternation logic
  - [ ] Test conversation history building

- [ ] **Edge case testing**
  - [ ] Test with very long conversations
  - [ ] Test with rapid user interactions
  - [ ] Test with tab switching during sessions
  - [ ] Test with LLM rate limiting

### 4.2 Integration Testing
- [ ] **Backward compatibility**
  - [ ] Verify existing forwarding still works
  - [ ] Verify popup functionality unchanged
  - [ ] Verify simple response capture still works
  - [ ] Test mode switching between simple and multi-agent

- [ ] **Cross-browser testing**
  - [ ] Test in Chrome stable
  - [ ] Test with different LLM UI versions
  - [ ] Test DOM selector reliability
  - [ ] Test performance impact

## Phase 5: Polish and Enhancement (Low Priority)

### 5.1 User Experience Improvements
- [ ] **Visual enhancements**
  - [ ] Add animated progress indicators
  - [ ] Add conversation visualization
  - [ ] Add session history viewer
  - [ ] Add export conversation functionality

- [ ] **Customization options**
  - [ ] Add custom prompt templates
  - [ ] Add configurable iteration counts
  - [ ] Add conversation style options
  - [ ] Add LLM role customization

### 5.2 Performance Optimization
- [ ] **Code optimization**
  - [ ] Optimize DOM queries in content scripts
  - [ ] Reduce memory usage for long sessions
  - [ ] Implement efficient state management
  - [ ] Add request debouncing

- [ ] **Monitoring and Analytics**
  - [ ] Add session success metrics
  - [ ] Add performance monitoring
  - [ ] Add error reporting
  - [ ] Add usage analytics

## Implementation Order

1. **Start Here**: Background script state management (1.1)
2. **Then**: Basic UI controls (1.2)
3. **Then**: Content script enhancements (1.3)
4. **Then**: Core conversation flow (2.1)
5. **Then**: Integration work (2.2)
6. **Then**: Testing and validation (4.1, 4.2)
7. **Finally**: Polish and advanced features (3.1, 3.2, 5.1, 5.2)

## Success Criteria

- [ ] Successfully complete 3-iteration multi-agent conversations
- [ ] Maintain all existing extension functionality
- [ ] Handle common error scenarios gracefully
- [ ] Provide clear user feedback throughout sessions
- [ ] Demonstrate improved collaborative responses from LLMs

## Dependencies and Risks

- **DOM Stability**: LLM interfaces change frequently
- **Rate Limiting**: Multiple rapid requests may hit limits
- **State Management**: Complex session state requires careful handling
- **User Experience**: Need clear distinction between modes
- **Performance**: Long conversations may impact browser performance