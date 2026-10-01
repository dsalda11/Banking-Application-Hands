import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadEnvironment } from './env.js';

beforeEach(() => {
  vi.stubEnv('BANK_STAFF_USERNAME', '');
  vi.stubEnv('BANK_STAFF_PASSWORD', '');
  vi.stubEnv('OPENAI_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadEnvironment', () => {
  it('loads defaults without credentials', () => {
    const environment = loadEnvironment();
    expect(environment.bankAppBaseUrl).toBe('http://127.0.0.1:8080');
    expect(environment.browserHeadless).toBe(false);
    expect(environment.operatorPort).toBe(3210);
    expect(environment.discoveryMaxModelCalls).toBe(30);
  });

  it('loads valid custom configuration', () => {
    vi.stubEnv('BANK_APP_BASE_URL', 'http://localhost:9090');
    vi.stubEnv('BROWSER_HEADLESS', 'true');
    vi.stubEnv('OPERATOR_PORT', '4000');
    vi.stubEnv('OPENAI_MODEL', 'custom-model');
    vi.stubEnv('DISCOVERY_MAX_ACTIONS', '9');
    const environment = loadEnvironment();
    expect(environment.bankAppBaseUrl).toBe('http://localhost:9090');
    expect(environment.browserHeadless).toBe(true);
    expect(environment.operatorPort).toBe(4000);
    expect(environment.openAiModel).toBe('custom-model');
    expect(environment.discoveryMaxActions).toBe(9);
  });

  it('rejects invalid URLs and ports', () => {
    vi.stubEnv('BANK_APP_BASE_URL', 'not-a-url');
    expect(() => loadEnvironment()).toThrow();
    vi.stubEnv('BANK_APP_BASE_URL', 'http://127.0.0.1:8080');
    vi.stubEnv('OPERATOR_PORT', '70000');
    expect(() => loadEnvironment()).toThrow();
  });

  it('parses true and false without truthy coercion', () => {
    vi.stubEnv('BROWSER_HEADLESS', 'true');
    expect(loadEnvironment().browserHeadless).toBe(true);
    vi.stubEnv('BROWSER_HEADLESS', 'false');
    expect(loadEnvironment().browserHeadless).toBe(false);
  });

  it('requires OpenAI credentials only when requested', () => {
    expect(() => loadEnvironment({ requireOpenAI: true })).toThrow('OPENAI_API_KEY');
  });

  it('requires banking credentials only when requested', () => {
    expect(() => loadEnvironment({ requireBankCredentials: true })).toThrow('BANK_STAFF_USERNAME');
  });

  it('does not expose secret values in validation errors', () => {
    const secret = 'canary-bank-password-123';
    vi.stubEnv('BANK_STAFF_PASSWORD', secret);
    vi.stubEnv('BROWSER_HEADLESS', 'not-a-boolean');
    try {
      loadEnvironment();
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
