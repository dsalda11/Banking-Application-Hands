import { describe, expect, it } from 'vitest';

import { isDoctorReady, type DoctorReadiness } from './doctor.js';

const readyReport: DoctorReadiness = {
  node24InUse: true,
  directories: { artifacts: true, policies: true, evidence: true },
  openAiConfigured: true,
  bankCredentialsConfigured: true,
};

describe('doctor readiness', () => {
  it('passes replay readiness without provider credentials', () => {
    expect(isDoctorReady({ ...readyReport, openAiConfigured: false })).toBe(true);
  });

  it('passes when genuine discovery prerequisites are present', () => {
    expect(isDoctorReady(readyReport)).toBe(true);
  });

  it('requires provider credentials in discovery mode', () => {
    expect(isDoctorReady({ ...readyReport, openAiConfigured: false }, 'discovery')).toBe(false);
    expect(isDoctorReady(readyReport, 'discovery')).toBe(true);
  });

  it.each([
    ['Node 24', { node24InUse: false }],
    ['a writable directory', { directories: { artifacts: true, policies: false, evidence: true } }],
    ['bank credentials', { bankCredentialsConfigured: false }],
  ] satisfies ReadonlyArray<readonly [string, Partial<DoctorReadiness>]>)(
    'fails when %s is missing',
    (_name, override) => {
      expect(isDoctorReady({ ...readyReport, ...override })).toBe(false);
    },
  );
});
