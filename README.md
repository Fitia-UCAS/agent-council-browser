# Multi-LLM Coder Chrome Extension

A powerful Chrome extension that allows developers to send prompts simultaneously to multiple LLM providers (Gemini and ChatGPT) and compare responses side-by-side in a convenient Chrome side panel.

## ✨ Features

- **Multi-LLM Support**: Send prompts to Gemini and ChatGPT simultaneously
- **Side Panel Interface**: Persistent, accessible UI that doesn't interfere with your workflow
- **Response Comparison**: View responses side-by-side to compare different LLM outputs
- **Dark Theme**: Professional dark theme optimized for developers
- **Real-time Status**: Live connection status and progress indicators
- **Syntax Highlighting**: Code blocks are automatically highlighted
- **Keyboard Shortcuts**: Ctrl/Cmd+Enter to send prompts quickly

## 🚀 Installation

### Method 1: Load Unpacked Extension (Recommended for Development)

1. **Download or Clone** this repository to your local machine
2. **Open Chrome** and navigate to `chrome://extensions/`
3. **Enable Developer Mode** by toggling the switch in the top-right corner
4. **Click "Load unpacked"** and select the folder containing the extension files
5. **Pin the extension** by clicking the puzzle piece icon and pinning "Multi-LLM Coder"

### Method 2: Manual Installation

1. Download all files from this repository
2. Ensure you have these files in a folder:
   - `manifest.json`
   - `sidepanel.html`
   - `sidepanel.js`
   - `background.js`
   - `selectors.js`
   - `styles.css`
3. Follow steps 2-5 from Method 1

## 📖 Usage

### Initial Setup

1. **Open LLM Websites**: 
   - Open [Gemini](https://gemini.google.com) in one tab
   - Open [ChatGPT](https://chat.openai.com) in another tab
   - Make sure you're logged into both services

2. **Open the Extension**:
   - Click the Multi-LLM Coder icon in your Chrome toolbar
   - Or use the keyboard shortcut (if configured)

### Sending Prompts

1. **Enter Your Prompt**: Type your question or request in the text area
2. **Select LLMs**: Check the boxes for Gemini and/or ChatGPT
3. **Send**: Click the "Send to LLMs" button or press Ctrl/Cmd+Enter
4. **View Responses**: Switch between tabs to see individual responses or use the Compare tab

### Interface Overview

- **Input Area**: Large text area with character counter
- **LLM Selection**: Checkboxes to choose which LLMs to query
- **Tabs**: 
  - **Gemini**: View Gemini's response
  - **ChatGPT**: View ChatGPT's response  
  - **Compare**: Side-by-side comparison view
- **Status Bar**: Shows connection status and last update time

## 🔧 How It Works

The extension uses Chrome's scripting API to interact with LLM websites:

1. **Tab Detection**: Finds open tabs with Gemini/ChatGPT
2. **Script Injection**: Injects JavaScript into the LLM websites
3. **DOM Interaction**: Fills input fields and clicks send buttons
4. **Response Monitoring**: Uses MutationObserver to detect when responses are complete
5. **Content Extraction**: Extracts response content and displays it in the side panel

## ⚠️ Important Notes

### Selector Updates
The extension relies on DOM selectors to interact with LLM websites. These may need updates when the websites change their interface. If the extension stops working:

1. Check the browser console for errors
2. Update selectors in `selectors.js` if needed
3. The selectors are the most volatile part of the extension

### Limitations
- Requires active tabs with Gemini and ChatGPT open
- Depends on website DOM structure (may break with UI updates)
- No offline functionality
- Responses are limited by the LLM websites' rate limits

## 🛠️ Development

### File Structure
```
chromeEX/
├── manifest.json          # Extension configuration
├── sidepanel.html         # Side panel UI
├── sidepanel.js          # UI logic and Chrome API communication
├── background.js         # Service worker for tab management
├── selectors.js          # DOM selectors for LLM websites
├── styles.css            # Dark theme styling
└── README.md            # This file
```

### Testing
- Use `python3 -m http.server 8000` to preview the UI at `http://localhost:8000/sidepanel.html`
- Check Chrome DevTools console for debugging information
- Test with both LLM websites open and logged in

### Updating Selectors
When LLM websites update their UI, update the selectors in `selectors.js`:

```javascript
const LLM_SELECTORS = {
    gemini: {
        input: 'textarea[placeholder*="Enter a prompt"]',
        sendButton: 'button[aria-label*="Send"]',
        // ... other selectors
    },
    chatgpt: {
        input: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        // ... other selectors
    }
};
```

## 🐛 Troubleshooting

### Extension Not Working
1. Check that you have Gemini/ChatGPT tabs open and loaded
2. Ensure you're logged into both services
3. Check the Chrome DevTools console for errors
4. Try refreshing the LLM website tabs

### No Responses Received
1. Verify the LLM websites are responsive
2. Check if selectors need updating
3. Look for errors in the background script console
4. Ensure the websites haven't changed their DOM structure

### Connection Status Shows "Not Connected"
1. Make sure the LLM websites are fully loaded
2. Check that the URLs match the host permissions in manifest.json
3. Try refreshing the extension

## 📝 License

This project is open source and available under the MIT License.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### Common Contribution Areas
- Updating selectors when LLM websites change
- Adding support for new LLM providers
- Improving error handling and user feedback
- Enhancing the UI/UX

## 📞 Support

If you encounter issues:
1. Check this README for troubleshooting steps
2. Look at the browser console for error messages
3. Create an issue on the project repository
4. Include browser version, extension version, and error details

## 📦 Dependencies & Installation

### System Requirements
- **Google Chrome** (version 88 or higher)
- **Developer Mode** enabled in Chrome Extensions
- **Internet Connection** (for LLM website access)

### No Traditional Dependencies Required
This Chrome extension is built with vanilla JavaScript and doesn't require Node.js, npm, or any build tools. All dependencies are either:
- Built into Chrome (Extension APIs)
- Loaded from CDN (highlight.js)
- Native Web APIs

### Quick Setup Script
For a streamlined setup process, you can use this script:

```bash
#!/bin/bash
# Multi-LLM Coder Extension Setup Script

echo "🚀 Setting up Multi-LLM Coder Chrome Extension..."

# Check if Chrome is installed
if ! command -v google-chrome &> /dev/null && ! command -v chrome &> /dev/null; then
    echo "❌ Google Chrome not found. Please install Chrome first."
    echo "   Download from: https://www.google.com/chrome/"
    exit 1
fi

echo "✅ Chrome detected"

# Clone or download the repository
if [ ! -d "chromeEX" ]; then
    echo "📥 Downloading extension files..."
    # If using git:
    # git clone <repository-url> chromeEX
    # Or download and extract manually
    echo "   Please ensure all extension files are in the current directory"
fi

# Verify required files
required_files=("manifest.json" "sidepanel.html" "sidepanel.js" "background.js" "selectors.js" "styles.css")
missing_files=()

for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        missing_files+=("$file")
    fi
done

if [ ${#missing_files[@]} -ne 0 ]; then
    echo "❌ Missing required files:"
    printf '   - %s\n' "${missing_files[@]}"
    exit 1
fi

echo "✅ All required files present"

# Run tests (optional)
if [ -f "tests/test-runner.html" ]; then
    echo "🧪 Test files available"
    echo "   Open tests/test-runner.html in Chrome to run validation tests"
fi

echo ""
echo "🎉 Setup complete! Next steps:"
echo "   1. Open Chrome and go to chrome://extensions/"
echo "   2. Enable 'Developer mode' (toggle in top-right)"
echo "   3. Click 'Load unpacked' and select this directory"
echo "   4. Open Gemini (gemini.google.com) and ChatGPT (chat.openai.com)"
echo "   5. Click the extension icon to start using Multi-LLM Coder"
echo ""
echo "📚 For detailed instructions, see the Installation section in README.md"
```

### Manual Verification
To verify your setup, check that you have these files:

```bash
# Verify all required files are present
ls -la manifest.json sidepanel.html sidepanel.js background.js selectors.js styles.css

# Optional: Run a simple HTTP server to preview the UI
python3 -m http.server 8000
# Then visit: http://localhost:8000/sidepanel.html
```

### Development Dependencies (Optional)
If you want to contribute to the project or run tests:

```bash
# For running a local HTTP server (testing UI)
python3 -m http.server 8000

# For code formatting (if you have prettier installed globally)
npx prettier --write "*.js" "*.html" "*.css"

# For linting (if you have eslint installed globally)  
npx eslint *.js
```

### External Dependencies
The extension automatically loads these external resources:
- **highlight.js** (v11.9.0) - For syntax highlighting in code blocks
- **Material Icons** - For UI icons
- **Chrome Extension APIs** - Built into Chrome browser

### Troubleshooting Dependencies
If the extension doesn't work properly:

1. **Check Chrome Version**: Ensure you're using Chrome 88+
2. **Verify Files**: Run the verification script above
3. **Test Network**: Ensure you can access gemini.google.com and chat.openai.com
4. **Check Console**: Open Chrome DevTools and look for any error messages

### No Build Process Required
Unlike many modern web projects, this extension:
- ✅ Requires no compilation or build step
- ✅ Uses no package managers (npm, yarn, etc.)
- ✅ Has no node_modules directory
- ✅ Works directly with Chrome's built-in APIs
- ✅ Loads external libraries via CDN

This makes it easy to modify, debug, and deploy without complex tooling.
