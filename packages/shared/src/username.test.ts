import { describe, expect, it } from 'vitest';
import { usernameToEmail } from './username';

describe('usernameToEmail', () => {
  it('appends the internal domain to a plain username', () => {
    expect(usernameToEmail('maria')).toBe('maria@fermosa.local');
  });

  it('trims and lowercases the username', () => {
    expect(usernameToEmail('  Maria.Santos ')).toBe('maria.santos@fermosa.local');
  });

  it('passes a real email through unchanged (lowercased)', () => {
    expect(usernameToEmail('hr@fermosa.test')).toBe('hr@fermosa.test');
    expect(usernameToEmail('HR@Fermosa.TEST')).toBe('hr@fermosa.test');
  });

  it('returns empty for empty input', () => {
    expect(usernameToEmail('   ')).toBe('');
  });
});
