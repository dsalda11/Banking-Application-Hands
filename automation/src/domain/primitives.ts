import { z } from 'zod';

/** A non-empty, human-readable string with a bounded size. */
export const NonEmptyString = z.string().trim().min(1).max(512);

/** Stable identifiers used in persisted contracts. */
export const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/);

/** ISO-8601 timestamp with an explicit timezone. */
export const Timestamp = z.iso.datetime({ offset: true });

/** Semantic version, including optional prerelease and build metadata. */
export const SemanticVersion = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

const JsonPrimitive = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

/** JSON-safe recursive value used by literal references and persisted facts. */
export const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    JsonPrimitive,
    z.array(JsonValue).max(100),
    z
      .record(z.string().max(128), JsonValue)
      .refine(
        (value) => Object.keys(value).length <= 100,
        'objects may contain at most 100 properties',
      ),
  ]),
);

/** A repository-relative evidence path or opaque storage key. */
export const EvidencePath = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value), 'must be relative')
  .refine((value) => !value.split(/[\\/]/).includes('..'), 'must not contain traversal');

export type JsonValueType = z.infer<typeof JsonValue>;
export type IdentifierType = z.infer<typeof Identifier>;
