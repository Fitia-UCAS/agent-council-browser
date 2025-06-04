# Multi-LLM Coder Extension - Development Plan

## Project Overview
A Chrome extension that allows developers to send prompts to multiple LLM providers (Gemini and ChatGPT) simultaneously and view responses side-by-side in a Chrome side panel.

## Current Status: Task 4 Complete - Moving to Task 5

## Project Structure
```
chromeEX/
├── manifest.json          # Chrome extension manifest (Manifest V3) ✅
├── background.js          # Service worker - orchestrates communication
├── sidepanel.html        # Side panel UI ✅
├── sidepanel.js          # Side panel logic
├── styles.css            # Styling for the extension ✅
├── selectors.js          # DOM selectors for LLM websites ✅
├── plan.md               # This file - development plan ✅
├── metadata.md           # Progress tracking and metadata ✅
└── tests/                # Test files ✅
    ├── test-manifest.js  # ✅
    ├── test-runner.html  # ✅
    ├── test-selectors.js # ✅
    └── test-background.js
```

## Task Breakdown

### ✅ Task 0: Project Setup
- [x] Create project directory
- [x] Create plan.md
- [x] Create metadata.md
- [x] Set up basic test structure

### ✅ Task 1: Create manifest.json
- [x] Create manifest.json with Manifest V3 structure
- [x] Define permissions: sidePanel, scripting, storage, tabs
- [x] Define host_permissions for Gemini and ChatGPT
- [x] Configure background service worker
- [x] Configure side panel
- [x] Add action for opening side panel
- [x] Write tests for manifest validation

### ✅ Task 2: Create selectors.js
- [x] Create selectors.js file
- [x] Define LLM_SELECTORS object structure
- [x] Add placeholder selectors for Gemini
- [x] Add placeholder selectors for ChatGPT
- [x] Document selector update process
- [x] Write tests for selector structure

### ✅ Task 3: Build sidepanel.html
- [x] Create HTML structure
- [x] Add input area with textarea
- [x] Add LLM selection checkboxes
- [x] Add send button
- [x] Create tabbed output area
- [x] Link CSS and JS files
- [x] Add highlight.js for syntax highlighting

### ✅ Task 4: Style with styles.css
- [x] Implement dark theme
- [x] Style input components
- [x] Style tabbed interface
- [x] Style code blocks
- [x] Add copy button styles
- [x] Make responsive layout

### ⏳ Task 5: Implement sidepanel.js
- [ ] Set up DOM references
- [ ] Implement tab switching
- [ ] Handle send button clicks
- [ ] Handle keyboard shortcuts (Ctrl/Cmd+Enter)
- [ ] Message passing to background.js
- [ ] Handle response display
- [ ] Implement code highlighting
- [ ] Add copy functionality
- [ ] Add "Send to..." functionality
- [ ] Write tests for UI logic

### 📋 Task 6: Implement background.js
- [ ] Set up service worker
- [ ] Handle extension installation
- [ ] Configure side panel behavior
- [ ] Implement message listeners
- [ ] Implement tab finding logic
- [ ] Implement script injection
- [ ] Handle response routing
- [ ] Error handling
- [ ] Write tests for background logic

### 📋 Task 7: Testing & Refinement
- [ ] Manual selector discovery
- [ ] Integration testing
- [ ] Error case testing
- [ ] Performance testing
- [ ] Documentation updates

## Testing Strategy
- Unit tests for each module
- Integration tests for message passing
- Manual testing with actual LLM websites
- Error scenario testing

## Known Challenges
1. DOM selectors will need frequent updates
2. MutationObserver logic for detecting response completion
3. Handling dynamic content on LLM websites
4. Cross-tab communication reliability

## Next Steps
1. ✅ Create metadata.md
2. ✅ Set up test structure
3. ✅ Begin Task 1: manifest.json 
4. ✅ Task 2: selectors.js
5. ✅ Task 3: sidepanel.html
6. ✅ Task 4: styles.css
7. ⏳ Task 5: sidepanel.js
