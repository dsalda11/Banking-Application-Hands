import { z } from 'zod';

import { NonEmptyString, JsonValue } from './primitives.js';

const ShapeBase = {
  description: NonEmptyString.optional(),
  example: JsonValue.optional(),
};

/** Recursive JSON-safe shape description used by capability contracts. */
export interface DataShapeType {
  readonly kind: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  readonly description?: string;
  readonly example?: unknown;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly properties?: Readonly<Record<string, DataShapeType>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: DataShapeType;
  readonly minItems?: number;
  readonly maxItems?: number;
}

const StringShape = z.strictObject({
  kind: z.literal('string'),
  ...ShapeBase,
  minLength: z.number().int().min(0).max(10000).optional(),
  maxLength: z.number().int().min(0).max(10000).optional(),
  pattern: z.string().min(1).max(256).optional(),
  enum: z.array(z.string().max(512)).min(1).max(100).optional(),
});
const NumberShape = z.strictObject({
  kind: z.literal('number'),
  ...ShapeBase,
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
});
const IntegerShape = z.strictObject({
  kind: z.literal('integer'),
  ...ShapeBase,
  minimum: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
  maximum: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
});
const BooleanShape = z.strictObject({ kind: z.literal('boolean'), ...ShapeBase });

export const DataShape = z.lazy(() =>
  z.discriminatedUnion('kind', [
    StringShape,
    NumberShape,
    IntegerShape,
    BooleanShape,
    z.strictObject({
      kind: z.literal('object'),
      ...ShapeBase,
      properties: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/), DataShape),
      required: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)).max(100),
      additionalProperties: z.literal(false),
    }),
    z.strictObject({
      kind: z.literal('array'),
      ...ShapeBase,
      items: DataShape,
      minItems: z.number().int().min(0).max(10000).optional(),
      maxItems: z.number().int().min(0).max(10000).optional(),
    }),
  ]),
) as z.ZodTypeAny;

export type DataShapeInferred = z.infer<typeof DataShape>;
