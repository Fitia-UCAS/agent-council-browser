# Arc Browser Notes

## Why it failed

On Arc, the extension click path based on Chrome Side Panel APIs was not reliable.  
The extension could start background checks (tab/profile/connection logs) but still fail to open the UI from the toolbar click.

## What was changed

1. Added a manual action-click open flow in `/background.js` instead of relying only on auto side-panel behavior.
2. Disabled automatic side-panel opening on action click with:
   - `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })`
3. Added Arc detection (`navigator.userAgent` / `userAgentData`) and forced Arc to open the extension UI in a normal extension tab (`sidepanel.html`).
4. Kept side-panel support for non-Arc browsers, with a safety fallback:
   - Try `chrome.sidePanel.open(...)`
   - If it fails (or no side-panel context appears), open `sidepanel.html` in a tab.

## Important clarification

Logs like `No ChatGPT tab found` / `No Claude tab found` / `No Grok tab found` are connection-state checks.  
They do **not** block opening the extension UI.
