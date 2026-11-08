import { maskSecrets } from '../core/security/masker.js';

// Every line the CLI prints goes through here, so terminal output is masked exactly like JSON output and tool replies.
export const out = (text = ''): void => console.log(maskSecrets(text).text);
export const err = (text = ''): void => console.error(maskSecrets(text).text);
