import { writeFile } from 'node:fs/promises';

import { ControlLeaseManager } from '../../src/intervention/control-lease.js';
import { OperatorInterventionCoordinator } from '../../src/intervention/intervention-coordinator.js';
import {
  InteractiveReplayLifecycle,
  processSignalSource,
} from '../../src/intervention/interactive-replay-lifecycle.js';

const evidencePath = process.argv[2];
if (!evidencePath) throw new Error('Evidence path is required');

let coordinator: OperatorInterventionCoordinator | undefined;
const lifecycle = new InteractiveReplayLifecycle({
  signalSource: processSignalSource,
  createCoordinator: (onUrl) => {
    coordinator = new OperatorInterventionCoordinator(onUrl);
    return coordinator;
  },
  runReplay: async (value, _signal, interruptionSource) => {
    const lease = new ControlLeaseManager('child-run', 'child-control', 'child fixture');
    const requested = lease.requestPause(lease.snapshot().generation);
    lease.pause(requested.generation);
    value.bindLease(lease);
    const decision = await value.awaitDecision({
      interventionId: 'child-intervention',
      runId: 'child-run',
      artifactId: 'child.artifact',
      artifactVersion: '1.0.0',
      stepId: 'human-step',
      policyId: 'child-policy',
      policyVersion: '1.0.0',
      reason: 'Controlled child-process signal fixture',
      risk: 'read',
      boundary: {
        pendingStepId: 'human-step',
        pendingActionType: 'navigate',
        retryable: true,
        consequential: false,
        leaseGeneration: lease.snapshot().generation,
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    if (decision.kind !== 'interrupted') throw new Error('Expected signal interruption');
    return {
      status: 'interrupted',
      runId: 'child-run',
      artifactId: 'child.artifact',
      artifactVersion: '1.0.0',
      code: 'INTERRUPTED_BY_SIGNAL',
      signal: interruptionSource() ?? decision.source,
      evidence: [],
      completedAt: new Date().toISOString(),
    };
  },
  outputOperatorUrl: (url) => {
    process.stdout.write(`READY ${new URL(url).port}\n`);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

await lifecycle.run();
const events = coordinator?.drainEvents() ?? [];
await writeFile(evidencePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
