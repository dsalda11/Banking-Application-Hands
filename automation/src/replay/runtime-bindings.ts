import type { DataShapeType } from '../domain/data-shapes.js';
import type { CapabilityArtifactType } from '../domain/index.js';

export type RuntimeBindingErrorCode =
  | 'INPUT_VALUE_MISSING'
  | 'INPUT_TYPE_MISMATCH'
  | 'UNDECLARED_INPUT'
  | 'SECRET_VALUE_MISSING'
  | 'UNDECLARED_SECRET';

export class RuntimeBindingError extends Error {
  constructor(
    readonly code: RuntimeBindingErrorCode,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeBindingError';
  }
}

export function matchesShape(value: unknown, shape: DataShapeType): boolean {
  switch (shape.kind) {
    case 'string':
      return (
        typeof value === 'string' &&
        (shape.minLength === undefined || value.length >= shape.minLength) &&
        (shape.maxLength === undefined || value.length <= shape.maxLength) &&
        (!shape.pattern || new RegExp(shape.pattern).test(value)) &&
        (!shape.enum || shape.enum.includes(value))
      );
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      if (!shape.items) return false;
      return (
        Array.isArray(value) &&
        (shape.minItems === undefined || value.length >= shape.minItems) &&
        (shape.maxItems === undefined || value.length <= shape.maxItems) &&
        value.every((item) => matchesShape(item, shape.items!))
      );
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      return (
        (shape.required ?? []).every((name) => name in object) &&
        Object.entries(object).every(
          ([name, item]) =>
            name in (shape.properties ?? {}) && matchesShape(item, shape.properties![name]!),
        )
      );
    }
  }
}

export interface RuntimeBindings {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly secretNames: readonly string[];
}

export function validateRuntimeBindings(
  artifact: CapabilityArtifactType,
  inputs: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, string>>,
): RuntimeBindings {
  for (const name of Object.keys(inputs))
    if (!(name in artifact.contract.inputs))
      throw new RuntimeBindingError(
        'UNDECLARED_INPUT',
        name,
        `Input ${name} is not declared by the artifact`,
      );
  for (const [name, spec] of Object.entries(artifact.contract.inputs)) {
    if (!(name in inputs))
      throw new RuntimeBindingError(
        'INPUT_VALUE_MISSING',
        name,
        `Required input ${name} is missing`,
      );
    if (!matchesShape(inputs[name], spec.shape as DataShapeType))
      throw new RuntimeBindingError(
        'INPUT_TYPE_MISMATCH',
        name,
        `Input ${name} does not match its declared shape`,
      );
  }
  for (const name of Object.keys(secrets))
    if (!artifact.contract.requiredSecrets.includes(name))
      throw new RuntimeBindingError(
        'UNDECLARED_SECRET',
        name,
        `Secret ${name} is not declared by the artifact`,
      );
  for (const name of artifact.contract.requiredSecrets)
    if (!secrets[name])
      throw new RuntimeBindingError(
        'SECRET_VALUE_MISSING',
        name,
        `Required secret ${name} is missing`,
      );
  return { inputs, secrets, secretNames: artifact.contract.requiredSecrets };
}
