# Simplified Extension Test Guide

## What Changed ✅

### Simplified Approach
- Removed complex response monitoring
- Focus on just sending prompts successfully
- Better selector fallback system
- Uses Enter key if send button not found

### New Selector Strategy
**ChatGPT:**
1. `#prompt-textarea`
2. `textarea[placeholder*="Message"]`
3. `textarea[data-id="root"]`
4. `textarea`
5. `[contenteditable="true"]`

**Gemini:**
1. `textarea[placeholder*="Enter a prompt"]`
2. `textarea[placeholder*="Ask"]`
3. `textarea`
4. `[contenteditable="true"]`

**Send Button (both):**
1. `button[data-testid*="send"]`
2. `button[aria-label*="Send"]`
3. `button[type="submit"]`
4. `button:has(svg)`
5. `button:last-of-type`
6. **Fallback:** Enter key

## Testing Steps

1. **Reload Extension** in Chrome
2. **Open ChatGPT and Gemini tabs**
3. **Open Extension Popup**
4. **Send Test Prompt:** "Hello, this is a test"
5. **Check Results:**
   - Extension should show "Prompt sent successfully"
   - Check ChatGPT/Gemini tabs to see if message appeared

## Expected Behavior

- ✅ Extension finds input field
- ✅ Types the prompt
- ✅ Either clicks send button OR presses Enter
- ✅ Shows success message
- ✅ Prompt appears in LLM interface

## Debug Info

To see what's happening:
1. Open ChatGPT/Gemini tab
2. Press F12 → Console
3. Send prompt from extension
4. Check console for messages like:
   - `"Found input with: textarea"`
   - `"Found send button with: button[aria-label*="Send"]"`

## If Still Not Working

The console will show exactly which selector worked or failed, making it easy to identify what needs to be updated. 