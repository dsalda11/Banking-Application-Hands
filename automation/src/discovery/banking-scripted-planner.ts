import type { DiscoveryObservationType, DiscoveryProposalType } from '../domain/discovery.js';
import { ScriptedPlannerClient } from './planner-client.js';

function normalized(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

function findElement(
  observation: DiscoveryObservationType,
  predicate: (element: DiscoveryObservationType['elements'][number]) => boolean,
  purpose: string,
): string {
  const element = observation.elements.find(predicate);
  if (!element) throw new Error(`Scripted planner could not observe ${purpose}`);
  return element.reference;
}

/**
 * Deterministic fake planner used only to exercise discovery. It chooses from
 * current semantic observations and never supplies selectors to the compiler.
 */
export function createBankingScriptedPlanner(): ScriptedPlannerClient {
  let loginEntry = 0;
  let customerEntry = 0;
  let extracted = 0;
  return new ScriptedPlannerClient((request, call) => {
    const { observation } = request;
    const pathname = new URL(observation.url).pathname;
    const base = (kind: DiscoveryProposalType['kind']) => ({
      kind,
      proposalId: `bank-fake-${call + 1}`,
      observationId: observation.observationId,
      stateFingerprint: observation.stateFingerprint,
      rationale: 'Deterministic fake planner selected a semantic observation candidate.',
      expectedPostcondition: 'The observed banking workflow advances.',
    });
    if (pathname === '/index') {
      if (loginEntry === 0) {
        loginEntry += 1;
        return {
          ...base('enterSecret'),
          kind: 'enterSecret' as const,
          elementReference: findElement(
            observation,
            (element) =>
              element.editable &&
              element.inputType !== 'password' &&
              normalized(element.name).includes('username'),
            'staff username field',
          ),
          secretName: 'BANK_STAFF_USERNAME',
        };
      }
      if (loginEntry === 1) {
        loginEntry += 1;
        return {
          ...base('enterSecret'),
          kind: 'enterSecret' as const,
          elementReference: findElement(
            observation,
            (element) => element.inputType === 'password',
            'staff password field',
          ),
          secretName: 'BANK_STAFF_PASSWORD',
        };
      }
      return {
        ...base('pressKey'),
        kind: 'pressKey' as const,
        elementReference: findElement(
          observation,
          (element) => element.inputType === 'password',
          'password submit field',
        ),
        key: 'Enter' as const,
      };
    }
    if (pathname === '/staff')
      return {
        ...base('click'),
        kind: 'click' as const,
        elementReference: findElement(
          observation,
          (element) => element.role === 'link' && normalized(element.text).includes('customers'),
          'Customers link',
        ),
      };
    if (pathname === '/showcust') {
      if (observation.visibleText.some((text) => normalized(text).includes('customer not found')))
        return {
          ...base('reportBusinessOutcome'),
          kind: 'reportBusinessOutcome' as const,
          outcomeCode: 'CUSTOMER_NOT_FOUND',
        };
      const search = findElement(
        observation,
        (element) =>
          element.editable && normalized(element.name).includes('find customer by username'),
        'customer search field',
      );
      if (customerEntry === 0) {
        customerEntry += 1;
        return {
          ...base('enterInput'),
          kind: 'enterInput' as const,
          elementReference: search,
          inputName: 'customerUsername',
        };
      }
      if (customerEntry === 1) {
        customerEntry += 1;
        return {
          ...base('pressKey'),
          kind: 'pressKey' as const,
          elementReference: search,
          key: 'Enter' as const,
        };
      }
      return {
        ...base('click'),
        kind: 'click' as const,
        elementReference: findElement(
          observation,
          (element) => element.role === 'link' && normalized(element.text) === 'view details',
          'View Details link',
        ),
      };
    }
    if (pathname === '/getDetails') {
      const tableCells = observation.elements.filter((element) => element.tagName === 'td');
      const valueAfter = (label: string) => {
        const index = tableCells.findIndex((element) => normalized(element.text) === label);
        if (index < 0 || !tableCells[index + 1])
          throw new Error(`Missing table value after ${label}`);
        return tableCells[index + 1]!.reference;
      };
      if (extracted === 0) {
        extracted += 1;
        return {
          ...base('extract'),
          kind: 'extract' as const,
          elementReference: valueAfter('account no.'),
          outputName: 'accountNumber',
          transform: 'trim' as const,
        };
      }
      if (extracted === 1) {
        extracted += 1;
        return {
          ...base('extract'),
          kind: 'extract' as const,
          elementReference: valueAfter('balance'),
          outputName: 'currentBalance',
          transform: 'amountUsd' as const,
        };
      }
      return { ...base('finish'), kind: 'finish' as const };
    }
    return {
      ...base('stopSafely'),
      kind: 'stopSafely' as const,
      reason: `Unsupported observed route ${pathname}`,
    };
  });
}
