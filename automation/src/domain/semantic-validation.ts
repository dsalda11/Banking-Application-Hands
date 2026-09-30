import type { CapabilityArtifactType } from './artifact.js';
import type { CheckpointType } from './checkpoints.js';
import type { DataShapeType } from './data-shapes.js';
import type { ValueSourceType } from './values.js';
import type {
  LocatorCandidateType,
  LocatorValueSourceType,
  TargetDescriptorType,
} from './locators.js';

export interface SemanticIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly stepId?: string;
  readonly severity: 'error' | 'warning';
}

export interface SemanticValidationResult {
  readonly valid: boolean;
  readonly issues: readonly SemanticIssue[];
}

const issue = (
  issues: SemanticIssue[],
  code: string,
  message: string,
  path?: string,
  stepId?: string,
  severity: SemanticIssue['severity'] = 'error',
) => {
  issues.push({
    code,
    message,
    ...(path ? { path } : {}),
    ...(stepId ? { stepId } : {}),
    severity,
  });
};

function validateShape(shape: DataShapeType, path: string, issues: SemanticIssue[]): void {
  if (shape.kind === 'object') {
    const properties = shape.properties ?? {};
    const required = shape.required ?? [];
    const names = new Set(Object.keys(properties));
    for (const requiredName of required) {
      if (!names.has(requiredName))
        issue(
          issues,
          'REQUIRED_PROPERTY_UNDECLARED',
          `Required property ${requiredName} is not declared`,
          `${path}.required`,
        );
    }
    for (const [name, child] of Object.entries(properties))
      validateShape(child, `${path}.properties.${name}`, issues);
  } else if (shape.kind === 'array') {
    if (shape.items) validateShape(shape.items, `${path}.items`, issues);
  }
}

function visitCheckpoint(checkpoint: CheckpointType, callback: (output: string) => void): void {
  switch (checkpoint.kind) {
    case 'outputPresent':
    case 'outputMatchesShape':
      if (checkpoint.output) callback(checkpoint.output);
      break;
    case 'all':
    case 'any':
      checkpoint.children?.forEach((child) => visitCheckpoint(child, callback));
      break;
    case 'not':
      if (checkpoint.child) visitCheckpoint(checkpoint.child, callback);
      break;
    default:
      break;
  }
}

export function validateArtifactSemantics(
  artifact: CapabilityArtifactType,
): SemanticValidationResult {
  const issues: SemanticIssue[] = [];
  const inputNames = new Set(Object.keys(artifact.contract.inputs));
  const secretNames = new Set(artifact.contract.requiredSecrets);
  const outputNames = new Set(Object.keys(artifact.contract.outputs));
  const stepIds = new Set<string>();
  const outcomeCodes = new Set<string>();
  const extractedOutputs = new Set<string>();
  const referencedOutputs = new Set<string>();
  const successOutputs = new Set<string>();

  for (const [name, spec] of Object.entries(artifact.contract.inputs))
    validateShape(spec.shape as DataShapeType, `contract.inputs.${name}.shape`, issues);
  for (const [name, spec] of Object.entries(artifact.contract.outputs))
    validateShape(spec.shape as DataShapeType, `contract.outputs.${name}.shape`, issues);

  const visitValue = (value: ValueSourceType, path: string, stepId?: string) => {
    if (value.kind === 'input' && !inputNames.has(value.name))
      issue(issues, 'UNDECLARED_INPUT', `Input ${value.name} is not declared`, path, stepId);
    if (value.kind === 'secret' && !secretNames.has(value.name))
      issue(issues, 'UNDECLARED_SECRET', `Secret ${value.name} is not declared`, path, stepId);
  };
  const visitLocatorValue = (value: LocatorValueSourceType, path: string, stepId?: string) => {
    if (value.kind === 'input' && !inputNames.has(value.name))
      issue(issues, 'UNDECLARED_INPUT', `Input ${value.name} is not declared`, path, stepId);
  };
  const visitCandidate = (candidate: LocatorCandidateType, path: string, stepId?: string) => {
    if ('text' in candidate && candidate.text)
      visitLocatorValue(candidate.text, `${path}.text`, stepId);
    if ((candidate.strategy === 'role' || candidate.strategy === 'accessibility') && candidate.name)
      visitLocatorValue(candidate.name, `${path}.name`, stepId);
    if ('value' in candidate && candidate.value)
      visitLocatorValue(candidate.value, `${path}.value`, stepId);
  };
  const visitTarget = (target: TargetDescriptorType, path: string, stepId?: string) => {
    target.candidates.forEach((candidate, index) =>
      visitCandidate(candidate, `${path}.candidates.${index}`, stepId),
    );
    (target.framePath ?? []).forEach((candidate, index) =>
      visitCandidate(candidate, `${path}.framePath.${index}`, stepId),
    );
    (target.scope ?? []).forEach((candidate, index) =>
      visitCandidate(candidate, `${path}.scope.${index}`, stepId),
    );
  };
  const visitCheckpointOutputs = (checkpoint: CheckpointType, path: string, stepId?: string) =>
    visitCheckpoint(checkpoint, (name) => {
      referencedOutputs.add(name);
      if (!outputNames.has(name))
        issue(issues, 'UNDECLARED_OUTPUT', `Output ${name} is not declared`, path, stepId);
    });

  for (const [index, step] of artifact.steps.entries()) {
    if (stepIds.has(step.id))
      issue(
        issues,
        'DUPLICATE_STEP_ID',
        `Step ID ${step.id} is duplicated`,
        `steps.${index}.id`,
        step.id,
      );
    stepIds.add(step.id);
    visitCheckpointOutputs(step.checkpoint, `steps.${index}.checkpoint`, step.id);
    if (step.recovery.kind === 'retry' && step.risk === 'irreversibleWrite')
      issue(
        issues,
        'RETRY_IRREVERSIBLE',
        'Irreversible actions cannot use automatic retry',
        `steps.${index}.recovery`,
        step.id,
      );
    if (step.recovery.kind === 'retry' && step.recovery.maxAttempts > 3)
      issue(
        issues,
        'RETRY_LIMIT_EXCEEDED',
        'Retry attempts exceed the hard bound',
        `steps.${index}.recovery`,
        step.id,
      );
    const action = step.action;
    if ('target' in action && action.target)
      visitTarget(action.target, `steps.${index}.action.target`, step.id);
    if (
      action.kind === 'navigate' &&
      'kind' in action.destination &&
      (action.destination.kind === 'input' ||
        action.destination.kind === 'secret' ||
        action.destination.kind === 'literal')
    )
      visitValue(action.destination, `steps.${index}.action.destination`, step.id);
    if (action.kind === 'enterText' || action.kind === 'selectOption')
      visitValue(action.value, `steps.${index}.action.value`, step.id);
    if (action.kind === 'extract') {
      extractedOutputs.add(action.output);
      if (!outputNames.has(action.output))
        issue(
          issues,
          'UNDECLARED_OUTPUT',
          `Output ${action.output} is not declared`,
          `steps.${index}.action.output`,
          step.id,
        );
    }
    if (step.recovery.kind === 'reauthenticate') {
      for (const recoveryStep of step.recovery.steps) {
        visitCheckpointOutputs(
          recoveryStep.checkpoint,
          `steps.${index}.recovery.steps.${recoveryStep.id}.checkpoint`,
          recoveryStep.id,
        );
        const recoveryAction = recoveryStep.action;
        if ('target' in recoveryAction && recoveryAction.target)
          visitTarget(
            recoveryAction.target,
            `steps.${index}.recovery.steps.${recoveryStep.id}.action.target`,
            recoveryStep.id,
          );
        if (
          recoveryAction.kind === 'navigate' &&
          'kind' in recoveryAction.destination &&
          (recoveryAction.destination.kind === 'input' ||
            recoveryAction.destination.kind === 'secret' ||
            recoveryAction.destination.kind === 'literal')
        )
          visitValue(
            recoveryAction.destination,
            `steps.${index}.recovery.steps.${recoveryStep.id}.action.destination`,
            recoveryStep.id,
          );
        if (recoveryAction.kind === 'enterText' || recoveryAction.kind === 'selectOption')
          visitValue(
            recoveryAction.value,
            `steps.${index}.recovery.steps.${recoveryStep.id}.action.value`,
            recoveryStep.id,
          );
      }
      visitCheckpointOutputs(
        step.recovery.sessionExpired,
        `steps.${index}.recovery.sessionExpired`,
        step.id,
      );
      visitCheckpointOutputs(
        step.recovery.checkpoint,
        `steps.${index}.recovery.checkpoint`,
        step.id,
      );
    }
  }
  for (const [index, outcome] of artifact.contract.businessOutcomes.entries()) {
    if (outcomeCodes.has(outcome.code))
      issue(
        issues,
        'DUPLICATE_OUTCOME_CODE',
        `Outcome code ${outcome.code} is duplicated`,
        `contract.businessOutcomes.${index}.code`,
      );
    outcomeCodes.add(outcome.code);
    visitCheckpointOutputs(outcome.detection, `contract.businessOutcomes.${index}.detection`);
    for (const output of outcome.detailsOutputs ?? []) {
      referencedOutputs.add(output);
      if (!outputNames.has(output))
        issue(
          issues,
          'UNDECLARED_OUTPUT',
          `Output ${output} is not declared`,
          `contract.businessOutcomes.${index}.detailsOutputs`,
        );
    }
  }
  for (const [index, precondition] of artifact.preconditions.entries())
    visitCheckpointOutputs(precondition, `preconditions.${index}`);
  visitCheckpointOutputs(artifact.success, 'success');
  visitCheckpoint(artifact.success, (name) => successOutputs.add(name));

  for (const output of outputNames)
    if (!extractedOutputs.has(output))
      issue(
        issues,
        'OUTPUT_NEVER_PRODUCED',
        `Declared output ${output} is never extracted or produced`,
        'contract.outputs',
      );
  if (successOutputs.size === 0 || [...outputNames].some((name) => !successOutputs.has(name)))
    issue(
      issues,
      'SUCCESS_OUTPUT_CHECK_MISSING',
      'Final success checkpoint must verify every declared output',
      'success',
    );
  const hasStrongLocator = artifact.steps.some((step) => {
    const action = step.action;
    if (!['activate', 'enterText', 'selectOption', 'extract'].includes(action.kind)) return false;
    return (
      'target' in action &&
      action.target !== undefined &&
      action.target.candidates.some((candidate) => candidate.strategy !== 'visualAnchor')
    );
  });
  if (!hasStrongLocator)
    issue(
      issues,
      'NO_USABLE_NON_COORDINATE_LOCATOR',
      'Artifact has no usable non-coordinate locator',
    );
  if (artifact.lifecycle === 'validated' || artifact.lifecycle === 'approved') {
    if (!artifact.metadata.compilerVersion || !artifact.metadata.checksum)
      issue(
        issues,
        'LIFECYCLE_METADATA_MISSING',
        'Validated or approved artifacts require compilerVersion and checksum',
        'metadata',
      );
    if (artifact.metadata.provenance.kind !== 'discoveryRun')
      issue(
        issues,
        'LIFECYCLE_PROVENANCE_MISSING',
        'Validated or approved artifacts require discovery-run provenance',
        'metadata.provenance',
      );
  }
  return { valid: !issues.some((entry) => entry.severity === 'error'), issues };
}
