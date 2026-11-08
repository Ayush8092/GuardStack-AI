import { InputError } from '../../utils/errors.js';
import { findUnverifiable, maskSecrets, type Unverifiable } from './masker.js';

export type Outbound = { system: string; prompt: string; redactions: number; unverifiable: Unverifiable[] };

export class OutboundBlocked extends InputError {
  constructor(message: string) {
    super(message, 'outbound_blocked');
  }
}

const describe = (items: Unverifiable[]): string => items.map((u) => `${u.count} ${u.kind.replace(/-/g, ' ')}`).join(', ');

export function strictFromEnv(configured: boolean): boolean {
  const raw = process.env.GUARDIAN_STRICT?.trim().toLowerCase();
  if (raw === undefined || raw === '') return configured;
  return ['1', 'on', 'true', 'yes'].includes(raw);
}

// The only way text reaches an external provider. Both halves are masked as one unit right before sending,
// then re-scanned: if anything still looks like a secret the payload is refused rather than sent.
// In strict mode the payload is also refused when it holds content the masker cannot vouch for (key-like
// high-entropy strings, encoded blobs, binary data, or more text than it scans), so a miss fails closed.
export function prepareOutbound(system: string, prompt: string, options: { strict?: boolean } = {}): Outbound {
  // Any failure while masking or re-checking blocks the send. Nothing is ever sent on the strength of a masking step that did not finish.
  let maskedSystem: ReturnType<typeof maskSecrets>;
  let maskedPrompt: ReturnType<typeof maskSecrets>;
  try {
    maskedSystem = maskSecrets(system);
    maskedPrompt = maskSecrets(prompt);
    if (maskSecrets(maskedSystem.text).count > 0 || maskSecrets(maskedPrompt.text).count > 0) {
      throw new OutboundBlocked('Outbound payload failed secret verification and was not sent');
    }
  } catch (err) {
    if (err instanceof OutboundBlocked) throw err;
    throw new OutboundBlocked('Masking the outbound payload failed, so nothing was sent');
  }

  const unverifiable = [...findUnverifiable(maskedSystem.text), ...findUnverifiable(maskedPrompt.text)];
  if (options.strict && unverifiable.length > 0) {
    throw new OutboundBlocked(`Strict mode: the outbound payload contains content that could not be verified as free of secrets (${describe(unverifiable)}), so nothing was sent`);
  }
  return { system: maskedSystem.text, prompt: maskedPrompt.text, redactions: maskedSystem.count + maskedPrompt.count, unverifiable };
}
