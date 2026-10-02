import { z } from 'zod';

import { getRepositoryPaths, type RepositoryPaths } from './paths.js';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
const environments = ['development', 'test', 'production'] as const;

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const portSchema = z.coerce.number().int().min(1).max(65535);
const boundedInteger = (fallback: number, minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);
const booleanSchema = z
  .string()
  .default('false')
  .transform((value, context) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be true or false' });
    return z.NEVER;
  });

const rawEnvironmentSchema = z.object({
  NODE_ENV: z.enum(environments).default('development'),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  BANK_APP_BASE_URL: z.string().url().default('http://127.0.0.1:8080'),
  BANK_STAFF_USERNAME: optionalSecret,
  BANK_STAFF_PASSWORD: optionalSecret,
  BANK_NON_STAFF_USERNAME: optionalSecret,
  BANK_NON_STAFF_PASSWORD: optionalSecret,
  BANK_CUSTOMER_USERNAME: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-5.6-terra'),
  DISCOVERY_SEND_SCREENSHOTS: booleanSchema,
  DISCOVERY_MAX_MODEL_CALLS: boundedInteger(30, 1, 200),
  DISCOVERY_MAX_ACTIONS: boundedInteger(30, 1, 200),
  DISCOVERY_TIMEOUT_MS: boundedInteger(120000, 1000, 3_600_000),
  DISCOVERY_MAX_REPEATED_STATES: boundedInteger(3, 1, 20),
  DISCOVERY_MAX_CONSECUTIVE_FAILURES: boundedInteger(3, 1, 20),
  BROWSER_HEADLESS: booleanSchema,
  OPERATOR_HOST: z.string().trim().min(1).default('127.0.0.1'),
  OPERATOR_PORT: portSchema.default(3210),
  ARTIFACTS_DIR: z.string().trim().min(1).default('../artifacts'),
  POLICIES_DIR: z.string().trim().min(1).default('../policies'),
  EVIDENCE_DIR: z.string().trim().min(1).default('../evidence'),
});

export interface LoadEnvironmentOptions {
  readonly requireOpenAI?: boolean;
  readonly requireBankCredentials?: boolean;
  readonly requireNonStaffCredentials?: boolean;
}

export interface AutomationEnvironment {
  readonly nodeEnvironment: (typeof environments)[number];
  readonly logLevel: (typeof logLevels)[number];
  readonly bankAppBaseUrl: string;
  readonly bankStaffUsername?: string;
  readonly bankStaffPassword?: string;
  readonly bankNonStaffUsername?: string;
  readonly bankNonStaffPassword?: string;
  readonly bankCustomerUsername?: string;
  readonly openAiApiKey?: string;
  readonly openAiModel: string;
  readonly discoverySendScreenshots: boolean;
  readonly discoveryMaxModelCalls: number;
  readonly discoveryMaxActions: number;
  readonly discoveryTimeoutMs: number;
  readonly discoveryMaxRepeatedStates: number;
  readonly discoveryMaxConsecutiveFailures: number;
  readonly browserHeadless: boolean;
  readonly operatorHost: string;
  readonly operatorPort: number;
  readonly paths: RepositoryPaths;
}

function requiredSecret(
  value: string | undefined,
  name: string,
  required: boolean,
): string | undefined {
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadEnvironment(options: LoadEnvironmentOptions = {}): AutomationEnvironment {
  const parsed = rawEnvironmentSchema.parse(process.env);
  const openAiApiKey = requiredSecret(
    parsed.OPENAI_API_KEY,
    'OPENAI_API_KEY',
    options.requireOpenAI ?? false,
  );
  const bankStaffUsername = requiredSecret(
    parsed.BANK_STAFF_USERNAME,
    'BANK_STAFF_USERNAME',
    options.requireBankCredentials ?? false,
  );
  const bankStaffPassword = requiredSecret(
    parsed.BANK_STAFF_PASSWORD,
    'BANK_STAFF_PASSWORD',
    options.requireBankCredentials ?? false,
  );
  const bankNonStaffUsername = requiredSecret(
    parsed.BANK_NON_STAFF_USERNAME,
    'BANK_NON_STAFF_USERNAME',
    options.requireNonStaffCredentials ?? false,
  );
  const bankNonStaffPassword = requiredSecret(
    parsed.BANK_NON_STAFF_PASSWORD,
    'BANK_NON_STAFF_PASSWORD',
    options.requireNonStaffCredentials ?? false,
  );

  return Object.freeze({
    nodeEnvironment: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    bankAppBaseUrl: parsed.BANK_APP_BASE_URL,
    ...(bankStaffUsername ? { bankStaffUsername } : {}),
    ...(bankStaffPassword ? { bankStaffPassword } : {}),
    ...(bankNonStaffUsername ? { bankNonStaffUsername } : {}),
    ...(bankNonStaffPassword ? { bankNonStaffPassword } : {}),
    ...(parsed.BANK_CUSTOMER_USERNAME
      ? { bankCustomerUsername: parsed.BANK_CUSTOMER_USERNAME }
      : {}),
    ...(openAiApiKey ? { openAiApiKey } : {}),
    openAiModel: parsed.OPENAI_MODEL,
    discoverySendScreenshots: parsed.DISCOVERY_SEND_SCREENSHOTS,
    discoveryMaxModelCalls: parsed.DISCOVERY_MAX_MODEL_CALLS,
    discoveryMaxActions: parsed.DISCOVERY_MAX_ACTIONS,
    discoveryTimeoutMs: parsed.DISCOVERY_TIMEOUT_MS,
    discoveryMaxRepeatedStates: parsed.DISCOVERY_MAX_REPEATED_STATES,
    discoveryMaxConsecutiveFailures: parsed.DISCOVERY_MAX_CONSECUTIVE_FAILURES,
    browserHeadless: parsed.BROWSER_HEADLESS,
    operatorHost: parsed.OPERATOR_HOST,
    operatorPort: parsed.OPERATOR_PORT,
    paths: getRepositoryPaths({
      artifactsDirectory: parsed.ARTIFACTS_DIR,
      policiesDirectory: parsed.POLICIES_DIR,
      evidenceDirectory: parsed.EVIDENCE_DIR,
    }),
  });
}
