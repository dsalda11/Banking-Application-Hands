import { z } from 'zod';

import { Checkpoint } from './checkpoints.js';
import { Identifier, NonEmptyString } from './primitives.js';

export const BusinessOutcome = z.strictObject({
  code: Identifier,
  description: NonEmptyString.max(256),
  detection: Checkpoint,
  detailsOutputs: z.array(Identifier).max(8).optional(),
});

export type BusinessOutcomeType = z.infer<typeof BusinessOutcome>;
