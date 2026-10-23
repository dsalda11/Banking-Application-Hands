import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

import { canonicalJsonFile } from '../compiler/canonical-json.js';
import { loadEnvironment } from '../config/env.js';

interface TenantBSuccessResult {
  readonly accountNumber: string;
  readonly balance: { readonly amount: string; readonly currency: 'USD' };
  readonly observedDifferences: readonly string[];
}

export interface TenantVariantSmokeResult {
  readonly runId: string;
  readonly status: 'success';
  readonly tenant: 'tenant-b';
  readonly successfulLookup: TenantBSuccessResult;
  readonly missingCustomer: 'CUSTOMER_NOT_FOUND';
  readonly evidencePath: string;
}

async function signIn(
  context: BrowserContext,
  baseUrl: string,
  username: string,
  password: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/tenant-b/login`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Harbor Community Bank', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Operations Sign In', exact: true }).waitFor();
  await page.getByLabel('Operator ID', { exact: true }).fill(username);
  await page.getByLabel('Passcode', { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL('**/tenant-b/operations'),
    page.getByRole('button', { name: 'Sign In', exact: true }).click(),
  ]);
  await page.getByRole('heading', { name: 'Operations Desk', exact: true }).waitFor();
  return page;
}

async function openDirectory(page: Page): Promise<void> {
  await Promise.all([
    page.waitForURL('**/tenant-b/clients'),
    page.getByRole('link', { name: 'Client Directory', exact: true }).click(),
  ]);
  await page.getByRole('heading', { name: 'Client Directory', exact: true }).waitFor();
}

async function findClient(page: Page, customerUsername: string): Promise<void> {
  await page.getByLabel('Search client login:', { exact: true }).fill(customerUsername);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/tenant-b/clients' && url.search.length > 0),
    page.getByRole('button', { name: 'Find Client', exact: true }).click(),
  ]);
}

async function runSuccessfulLookup(
  context: BrowserContext,
  baseUrl: string,
  staffUsername: string,
  staffPassword: string,
  customerUsername: string,
): Promise<TenantBSuccessResult> {
  const page = await signIn(context, baseUrl, staffUsername, staffPassword);
  await openDirectory(page);
  await findClient(page, customerUsername);

  const headers = await page.locator('table thead th').allTextContents();
  const normalizedHeaders = headers.map((header) => header.trim());
  if (normalizedHeaders.join('|') !== 'Client|Account Balance|Account Number|Login|Action')
    throw new Error(`Unexpected Tenant B account-table columns: ${normalizedHeaders.join('|')}`);

  const row = page.locator('table tbody tr').filter({ hasText: customerUsername });
  if ((await row.count()) !== 1)
    throw new Error('Tenant B lookup did not return exactly one client');
  const cells = await row.locator('td').allTextContents();
  const balanceAmount = cells[1]?.trim();
  const accountNumber = cells[2]?.trim();
  if (!accountNumber || !balanceAmount)
    throw new Error('Tenant B lookup did not expose dynamic account outputs');

  await Promise.all([
    page.waitForURL('**/tenant-b/client/account?**'),
    row.getByRole('link', { name: 'Open Account', exact: true }).click(),
  ]);
  await page.getByRole('heading', { name: 'Client Account Summary', exact: true }).waitFor();
  const detailText = await page.locator('fieldset').innerText();
  if (!detailText.includes(accountNumber) || !detailText.includes(`${balanceAmount} USD`))
    throw new Error('Tenant B account-detail page disagrees with the client-directory result');

  return {
    accountNumber,
    balance: { amount: balanceAmount, currency: 'USD' },
    observedDifferences: [
      'alternate /tenant-b route hierarchy',
      'Operator ID and Passcode login labels',
      'Client Directory and Search client login labels',
      'reordered Account Balance and Account Number columns',
      'nested legacy account-summary fieldset',
    ],
  };
}

async function runMissingLookup(
  context: BrowserContext,
  baseUrl: string,
  staffUsername: string,
  staffPassword: string,
): Promise<'CUSTOMER_NOT_FOUND'> {
  const page = await signIn(context, baseUrl, staffUsername, staffPassword);
  await openDirectory(page);
  await findClient(page, 'tenant-b-missing-customer');
  await page.getByText('No client matched the supplied login.', { exact: true }).waitFor();
  if ((await page.locator('table tbody tr').count()) !== 0)
    throw new Error('Tenant B missing-customer page unexpectedly exposed an account row');
  return 'CUSTOMER_NOT_FOUND';
}

export async function runTenantVariantSmoke(
  customerUsername: string,
  environment = loadEnvironment({ requireBankCredentials: true }),
): Promise<TenantVariantSmokeResult> {
  const runId = `tenant-variant-${randomUUID()}`;
  const browser = await chromium.launch({ headless: environment.browserHeadless });
  try {
    const successContext = await browser.newContext();
    const successfulLookup = await runSuccessfulLookup(
      successContext,
      environment.bankAppBaseUrl,
      environment.bankStaffUsername!,
      environment.bankStaffPassword!,
      customerUsername,
    );
    await successContext.close();

    const missingContext = await browser.newContext();
    const missingCustomer = await runMissingLookup(
      missingContext,
      environment.bankAppBaseUrl,
      environment.bankStaffUsername!,
      environment.bankStaffPassword!,
    );
    await missingContext.close();

    const relativeEvidencePath = path.join('local', `${runId}.json`);
    const absoluteEvidencePath = path.join(
      environment.paths.evidenceDirectory,
      relativeEvidencePath,
    );
    const result = {
      runId,
      status: 'success' as const,
      tenant: 'tenant-b' as const,
      successfulLookup,
      missingCustomer,
      evidencePath: path.posix.join('evidence', relativeEvidencePath),
    };
    await mkdir(path.dirname(absoluteEvidencePath), { recursive: true });
    await writeFile(absoluteEvidencePath, canonicalJsonFile(result), 'utf8');
    return result;
  } finally {
    await browser.close();
  }
}
