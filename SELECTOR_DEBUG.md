# Selector Debug Guide

## What We Fixed

### Enhanced Selector Detection
- Added fallback selectors for both ChatGPT and Gemini
- Better error reporting showing what elements are available
- Debug logging to see exactly what's found

### ChatGPT Fallback Selectors
**Input:**
- `textarea[placeholder*="Message"]`
- `textarea[data-id="root"]`
- `textarea`
- `#prompt-textarea`
- `[contenteditable="true"]`

**Send Button:**
- `button[aria-label*="Send"]`
- `button[data-testid*="send"]`
- `button:has(svg)`
- `button[type="submit"]`
- `button:last-of-type`

### Gemini Fallback Selectors
**Input:**
- `textarea[placeholder*="Enter a prompt"]`
- `textarea[placeholder*="Ask"]`
- `textarea`
- `[contenteditable="true"]`
- `input[type="text"]`

**Send Button:**
- `button[aria-label*="Send"]`
- `button[data-testid*="send"]`
- `button:has(svg)`
- `button[type="submit"]`
- `button:last-of-type`

## Testing Steps

1. **Reload Extension**
2. **Open Browser Console** (F12 → Console)
3. **Send a Test Prompt**
4. **Check Console Output** for:
   - Number of textareas/inputs found
   - Which fallback selector worked
   - List of all available buttons (if send button fails)

## Expected Results

- Should find input elements even if primary selectors fail
- Should find send buttons using fallback selectors
- Better error messages showing what was actually found
- Messages should send to both LLMs successfully

## If Still Failing

The console will now show:
- All available textareas and inputs
- All available buttons with their HTML
- Which selectors were tried and which worked

This will help us update the selectors to match the current website structure. 