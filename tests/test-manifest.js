/**
 * Test suite for manifest.json validation
 * Tests Chrome Extension Manifest V3 compliance
 */

// Mock manifest for testing
let manifest;

// Load manifest.json for testing
async function loadManifest() {
  try {
    const response = await fetch('../manifest.json');
    manifest = await response.json();
    return manifest;
  } catch (error) {
    console.error('Failed to load manifest.json:', error);
    return null;
  }
}

// Test suite
const manifestTests = {
  
  testManifestVersion() {
    console.log('Testing manifest version...');
    if (!manifest) {
      throw new Error('Manifest not loaded');
    }
    
    if (manifest.manifest_version !== 3) {
      throw new Error(`Expected manifest_version 3, got ${manifest.manifest_version}`);
    }
    
    console.log('✅ Manifest version 3 confirmed');
    return true;
  },

  testRequiredFields() {
    console.log('Testing required fields...');
    const required = ['name', 'version', 'description'];
    
    for (const field of required) {
      if (!manifest[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    console.log('✅ All required fields present');
    return true;
  },

  testPermissions() {
    console.log('Testing permissions...');
    const expectedPermissions = ['sidePanel', 'scripting', 'storage', 'tabs'];
    
    if (!manifest.permissions) {
      throw new Error('No permissions defined');
    }
    
    for (const permission of expectedPermissions) {
      if (!manifest.permissions.includes(permission)) {
        throw new Error(`Missing permission: ${permission}`);
      }
    }
    
    console.log('✅ All required permissions present');
    return true;
  },

  testHostPermissions() {
    console.log('Testing host permissions...');
    const expectedHosts = [
      'https://gemini.google.com/*',
      'https://chat.openai.com/*'
    ];
    
    if (!manifest.host_permissions) {
      throw new Error('No host_permissions defined');
    }
    
    for (const host of expectedHosts) {
      if (!manifest.host_permissions.includes(host)) {
        throw new Error(`Missing host permission: ${host}`);
      }
    }
    
    console.log('✅ All required host permissions present');
    return true;
  },

  testBackgroundServiceWorker() {
    console.log('Testing background service worker...');
    
    if (!manifest.background) {
      throw new Error('No background configuration');
    }
    
    if (!manifest.background.service_worker) {
      throw new Error('No service_worker defined');
    }
    
    if (manifest.background.service_worker !== 'background.js') {
      throw new Error(`Expected service_worker 'background.js', got '${manifest.background.service_worker}'`);
    }
    
    console.log('✅ Background service worker configured correctly');
    return true;
  },

  testSidePanel() {
    console.log('Testing side panel configuration...');
    
    if (!manifest.side_panel) {
      throw new Error('No side_panel configuration');
    }
    
    if (!manifest.side_panel.default_path) {
      throw new Error('No default_path for side panel');
    }
    
    if (manifest.side_panel.default_path !== 'sidepanel.html') {
      throw new Error(`Expected default_path 'sidepanel.html', got '${manifest.side_panel.default_path}'`);
    }
    
    console.log('✅ Side panel configured correctly');
    return true;
  },

  testAction() {
    console.log('Testing action configuration...');
    
    if (!manifest.action) {
      throw new Error('No action configuration');
    }
    
    console.log('✅ Action configured');
    return true;
  }
};

// Run all tests
async function runManifestTests() {
  console.log('🧪 Starting manifest.json tests...\n');
  
  try {
    await loadManifest();
    
    if (!manifest) {
      throw new Error('Could not load manifest.json');
    }
    
    // Run all tests
    manifestTests.testManifestVersion();
    manifestTests.testRequiredFields();
    manifestTests.testPermissions();
    manifestTests.testHostPermissions();
    manifestTests.testBackgroundServiceWorker();
    manifestTests.testSidePanel();
    manifestTests.testAction();
    
    console.log('\n🎉 All manifest tests passed!');
    return true;
    
  } catch (error) {
    console.error('\n❌ Manifest test failed:', error.message);
    return false;
  }
}

// Export for use in other test files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { manifestTests, runManifestTests };
}

// Auto-run if this file is loaded directly
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', runManifestTests);
} 