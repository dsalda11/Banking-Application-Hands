import { z } from 'zod';

import { Identifier, JsonValue } from './primitives.js';

/** A runtime value reference; secrets are names only and never values. */
export const ValueSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('input'), name: Identifier }),
  z.strictObject({ kind: z.literal('secret'), name: Identifier }),
  z.strictObject({ kind: z.literal('literal'), value: JsonValue }),
]);

export type ValueSourceType = z.infer<typeof ValueSource>;
