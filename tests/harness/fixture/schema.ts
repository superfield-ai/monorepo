/**
 * Zod schema for `meta.yaml` files inside `tests/scenarios/<category>/<lang>/<name>/`.
 *
 * Every field present in this schema is consumed by the harness; nothing
 * here is decoration. Per docs/test-plan.md §6.1 there is deliberately no
 * scoring DSL — ambiguity is resolved by Sharp's Tier 2 oracle and Tier 3
 * dilemma escalation, not by per-fixture knobs.
 */
import * as z from 'zod';

const OutcomeSchema = z.enum(['clean_ok', 'clean_wrong', 'conflict', 'dilemma', 'error']);

const CategorySchema = z.enum([
  'refactor',
  'reorder',
  'format',
  'move_edit',
  'delete_edit',
  'import_merge',
  'cross_file_rename',
  'whitespace_only',
]);

const LanguageSchema = z.enum(['ts', 'rust']);

/**
 * Validator selector:
 *   - 'ts'              → stock TypeScript validator (tests/validators/ts.ts)
 *   - 'rust'            → stock Rust validator (tests/validators/rust.ts)
 *   - relative path     → fixture-local TypeScript validator (e.g. './validator.ts')
 *   - omitted           → no validator (use expected/ for tree comparison)
 */
const ValidatorSchema = z.union([
  z.literal('ts'),
  z.literal('rust'),
  z
    .string()
    .regex(/^\.\.?\/.+\.ts$/, 'validator path must be a relative .ts file (e.g. ./validator.ts)'),
]);

export const ScenarioMetaSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9_]+$/, 'name must be snake_case ascii'),
    category: CategorySchema,
    language: LanguageSchema,
    summary: z.string().min(1),
    expected_git_outcome: OutcomeSchema,
    expected_sharp_outcome: OutcomeSchema,
    validator: ValidatorSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

export type ScenarioMetaInput = z.infer<typeof ScenarioMetaSchema>;
