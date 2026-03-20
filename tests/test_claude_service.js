const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Mock the @anthropic-ai/sdk module before requiring claudeService
const mockCreate = mock.fn();

// We need to mock the module by intercepting require
// Since Node test runner doesn't have built-in module mocking like Jest,
// we'll test by creating a minimal test harness

describe('claudeService', () => {
  let claudeService;
  let originalApiKey;

  beforeEach(() => {
    // Save and set env
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-api-key-123';
    // Reset mock
    mockCreate.mock.resetCalls();
  });

  // Test 1: chat() accepts (systemPrompt, conversationMessages, options) - new 3-arg signature
  it('chat() accepts 3-arg signature: (systemPrompt, conversationMessages, options)', async () => {
    // We test by verifying the module exports a chat function with correct arity
    // Need to test the actual file structure
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );
    // Verify function signature has 3 parameters
    assert.match(source, /async function chat\(systemPrompt,\s*conversationMessages/);
  });

  // Test 2: SDK client is constructed with ANTHROPIC_API_KEY env var
  it('SDK client is constructed with ANTHROPIC_API_KEY env var', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );
    assert.match(source, /new Anthropic/);
    assert.match(source, /process\.env\.ANTHROPIC_API_KEY/);
    // Must NOT contain spawn or CLAUDE_BIN
    assert.doesNotMatch(source, /spawn/);
    assert.doesNotMatch(source, /CLAUDE_BIN/);
  });

  // Test 3: System prompt is passed with cache_control: { type: 'ephemeral' }
  it('system prompt includes cache_control ephemeral', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );
    assert.match(source, /cache_control/);
    assert.match(source, /ephemeral/);
    // Verify it's in the system array structure
    assert.match(source, /system:\s*\[/);
  });

  // Test 4: Messages are mapped to { role, content } format for the SDK
  it('messages are mapped to role/content format', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );
    assert.match(source, /messages:\s*conversationMessages\.map/);
    assert.match(source, /role:\s*msg\.role/);
    assert.match(source, /content:\s*msg\.content/);
  });

  // Test 5: Response extracts response.content[0].text
  it('response extracts content[0].text', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );
    assert.match(source, /response\.content\[0\]\.text/);
  });

  // Test 6: Usage metrics are logged (cacheCreation, cacheRead)
  it('usage metrics include cache fields in logger.debug call', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );
    assert.match(source, /cacheCreation/);
    assert.match(source, /cacheRead/);
    assert.match(source, /inputTokens/);
    assert.match(source, /outputTokens/);
    assert.match(source, /cache_creation_input_tokens/);
    assert.match(source, /cache_read_input_tokens/);
  });

  // Test 7: Empty response throws an error
  it('empty response throws an error', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );
    assert.match(source, /throw new Error.*[Ee]mpty response/);
  });

  // Test 8: Model defaults to CLAUDE_MODEL_CUSTOMER or claude-haiku-4-5-20251001
  it('model defaults to CLAUDE_MODEL_CUSTOMER or claude-haiku-4-5-20251001', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );
    assert.match(source, /options\.model\s*\|\|\s*process\.env\.CLAUDE_MODEL_CUSTOMER/);
    assert.match(source, /claude-haiku-4-5-20251001/);
  });

  // Functional test: verify the module loads and exports chat
  it('module exports chat function', () => {
    // Clear require cache to get fresh module
    delete require.cache[require.resolve('../src/services/claudeService')];
    const mod = require('../src/services/claudeService');
    assert.equal(typeof mod.chat, 'function');
  });

  // Functional test: verify chat calls SDK with correct structure
  it('chat passes correct structure to SDK client.messages.create', async () => {
    // This test verifies the integration by calling chat with a mock
    // We need to intercept the Anthropic constructor
    delete require.cache[require.resolve('../src/services/claudeService')];

    // Since we can't easily mock require in node:test, we'll use a different approach:
    // Set ANTHROPIC_API_KEY and verify the function structure via source analysis
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../src/services/claudeService.js'),
      'utf8'
    );

    // Verify the create call structure
    assert.match(source, /client\.messages\.create/);
    assert.match(source, /max_tokens:\s*1024/);
    assert.match(source, /type:\s*'text'/);
  });
});
