# Arc Browser Notes

## Why it failed

On Arc, the extension click path based on Chrome Side Panel APIs was not reliable.  
The extension could start background checks (tab/profile/connection logs) but still fail to open the UI from the toolbar click.

## What was changed

1. Added a manual action-click open flow in `/background.js` instead of relying only on auto side-panel behavior.
2. Disabled automatic side-panel opening on action click with:
   - `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })`
3. Kept the open flow browser-agnostic:
   - Try `chrome.sidePanel.open(...)`
   - Verify a `SIDE_PANEL` context exists for `sidepanel.html`
   - If open fails, or no side-panel context appears, focus an existing `sidepanel.html` tab or open a new one
4. Arc compatibility now comes from that verified fallback path rather than a dedicated Arc user-agent branch.

## Important clarification

Logs like `No ChatGPT tab found` / `No Claude tab found` / `No Grok tab found` are connection-state checks.  
They do **not** block opening the extension UI.
