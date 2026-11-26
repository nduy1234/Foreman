import { z } from 'zod';
import { Rule } from '../lib/schemas';
import accessibility from './accessibility.json';
import egress from './egress.json';
import fireSeparation from './fire-separation.json';
import permitPrerequisites from './permit-prerequisites.json';
import structural from './structural.json';

/**
 * Curated code rule pack. Citations reference section numbers only; each `test` is a
 * paraphrased pass/fail description written for this app, not code text.
 * Validated at load so a malformed rule fails fast (and in unit tests).
 */
export const RULE_PACK_VERSION = '2026.11-1';

export const RULES: Rule[] = z
  .array(Rule)
  .parse([...egress, ...fireSeparation, ...accessibility, ...structural, ...permitPrerequisites]);

export const ruleById = (id: string) => RULES.find((r) => r.id === id);
