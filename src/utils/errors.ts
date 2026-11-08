export class InputError extends Error {
  constructor(
    message: string,
    readonly code: string = 'invalid_input',
  ) {
    super(message);
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
