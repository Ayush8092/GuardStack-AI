import type { Config } from '../../utils/config.js';
import { log } from '../../utils/logger.js';
import { hasLlmKeys } from './provider.js';

export type SecurityMode = 'local' | 'external';
export type PolicyReason = 'enabled' | 'env-off' | 'env-unset' | 'config-off' | 'flag-off' | 'no-keys';
export type Policy = { mode: SecurityMode; reason: PolicyReason };

const ON = new Set(['on', 'true', '1', 'yes']);
const OFF = new Set(['', 'off', 'false', '0', 'no']);

// Fail closed: nothing leaves the machine unless GUARDIAN_LLM=on is set explicitly, the project allows it and a key exists.
export function resolvePolicy(config: Pick<Config, 'llm'>, options: { disabled?: boolean } = {}): Policy {
  const raw = process.env.GUARDIAN_LLM?.trim().toLowerCase();
  if (options.disabled) return { mode: 'local', reason: 'flag-off' };
  if (raw === undefined) return { mode: 'local', reason: 'env-unset' };
  if (!ON.has(raw)) {
    if (!OFF.has(raw)) log.warn(`GUARDIAN_LLM="${raw}" is not recognised, staying fully local`);
    return { mode: 'local', reason: 'env-off' };
  }
  if (!config.llm) return { mode: 'local', reason: 'config-off' };
  if (!hasLlmKeys()) return { mode: 'local', reason: 'no-keys' };
  return { mode: 'external', reason: 'enabled' };
}

export function describePolicy(policy: Policy): string {
  if (policy.mode === 'external') {
    return 'External LLM mode: the request, up to 8 matching symbol signatures with file paths, and a folder summary are sent to Gemini or Groq after secret masking. No file contents or function bodies are sent. Set GUARDIAN_LLM=off to stay fully local.';
  }
  const why: Record<Exclude<PolicyReason, 'enabled'>, string> = {
    'env-off': 'GUARDIAN_LLM is off',
    'env-unset': 'GUARDIAN_LLM=on is not set',
    'config-off': '.guardianrc has "llm": false',
    'flag-off': '--no-llm was given',
    'no-keys': 'no API key is set',
  };
  return `Fully local mode: nothing leaves this machine (${why[policy.reason as Exclude<PolicyReason, 'enabled'>]}).`;
}
