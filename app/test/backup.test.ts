import { describe, expect, it } from 'vitest';
import { pgConn, pgDumpArgs, stripPrismaUrlParams } from '../src/lib/backup';

// Only the PURE functions are exercised here — no pg_dump spawn, no fs. These
// mirror the entrypoint's strip_prisma_url_params + backup_before_migrate logic,
// so the assertions are hand-derived from that bash.

describe('stripPrismaUrlParams', () => {
  it('drops the Prisma-only ?schema=public', () => {
    expect(
      stripPrismaUrlParams('postgresql://ngrid:pw@db:5432/ngrid?schema=public')
    ).toBe('postgresql://ngrid:pw@db:5432/ngrid');
  });

  it('keeps libpq-valid params like sslmode=require', () => {
    expect(
      stripPrismaUrlParams('postgresql://ngrid:pw@db:5432/ngrid?sslmode=require')
    ).toBe('postgresql://ngrid:pw@db:5432/ngrid?sslmode=require');
  });

  it('drops Prisma-only params from a mixed query but keeps libpq ones', () => {
    expect(
      stripPrismaUrlParams(
        'postgresql://ngrid:pw@db:5432/ngrid?schema=public&sslmode=require&connection_limit=5&connect_timeout=10'
      )
    ).toBe('postgresql://ngrid:pw@db:5432/ngrid?sslmode=require&connect_timeout=10');
  });

  it('passes through a URL with no query string unchanged', () => {
    expect(stripPrismaUrlParams('postgresql://ngrid:pw@db:5432/ngrid')).toBe(
      'postgresql://ngrid:pw@db:5432/ngrid'
    );
  });

  it('drops an empty fragment from a trailing &', () => {
    expect(
      stripPrismaUrlParams('postgresql://ngrid:pw@db:5432/ngrid?sslmode=require&')
    ).toBe('postgresql://ngrid:pw@db:5432/ngrid?sslmode=require');
  });

  it('returns just the base when only Prisma-only params are present', () => {
    expect(
      stripPrismaUrlParams('postgresql://ngrid:pw@db:5432/ngrid?schema=public&pgbouncer=true')
    ).toBe('postgresql://ngrid:pw@db:5432/ngrid');
  });
});

describe('pgConn — DB_PASSWORD set (discrete-args, #83 special-char path)', () => {
  it('parses host/port/user/db and carries the raw special-char password verbatim', () => {
    const { args, extraEnv } = pgConn({
      DATABASE_URL: 'postgresql://ngrid:ignored@dbhost:6543/ngrid?schema=public',
      DB_PASSWORD: 'p@ss#w$rd',
      DB_USER: 'ngrid',
      DB_NAME: 'ngrid',
    });
    expect(args).toEqual(['-h', 'dbhost', '-p', '6543', '-U', 'ngrid', '-d', 'ngrid']);
    expect(extraEnv).toEqual({ PGPASSWORD: 'p@ss#w$rd' });
  });

  it('defaults port to 5432 when the URL authority has no explicit port', () => {
    const { args } = pgConn({
      DATABASE_URL: 'postgresql://ngrid@dbhost/ngrid',
      DB_PASSWORD: 'secret',
    });
    expect(args).toEqual(['-h', 'dbhost', '-p', '5432', '-U', 'ngrid', '-d', 'ngrid']);
  });

  it('defaults user/db to ngrid when DB_USER/DB_NAME are unset', () => {
    const { args } = pgConn({
      DATABASE_URL: 'postgresql://whoever:x@dbhost:5432/whatever',
      DB_PASSWORD: 'secret',
    });
    expect(args).toEqual(['-h', 'dbhost', '-p', '5432', '-U', 'ngrid', '-d', 'ngrid']);
  });

  it('honors explicit DB_USER/DB_NAME', () => {
    const { args } = pgConn({
      DATABASE_URL: 'postgresql://ngrid:x@dbhost:5432/ngrid',
      DB_PASSWORD: 'secret',
      DB_USER: 'appuser',
      DB_NAME: 'appdb',
    });
    expect(args).toEqual(['-h', 'dbhost', '-p', '5432', '-U', 'appuser', '-d', 'appdb']);
  });
});

describe('pgConn — DB_PASSWORD unset/empty (URL conninfo)', () => {
  it('uses the stripped DATABASE_URL as a single conninfo arg with no PGPASSWORD', () => {
    const { args, extraEnv } = pgConn({
      DATABASE_URL: 'postgresql://ngrid:pw@db:5432/ngrid?schema=public&sslmode=require',
    });
    expect(args).toEqual(['postgresql://ngrid:pw@db:5432/ngrid?sslmode=require']);
    expect(extraEnv).toEqual({});
  });

  it('treats an empty DB_PASSWORD the same as unset', () => {
    const { args, extraEnv } = pgConn({
      DATABASE_URL: 'postgresql://ngrid:pw@db:5432/ngrid',
      DB_PASSWORD: '',
    });
    expect(args).toEqual(['postgresql://ngrid:pw@db:5432/ngrid']);
    expect(extraEnv).toEqual({});
  });
});

describe('pgDumpArgs', () => {
  it('prepends the clean-restore flags before the discrete connection args', () => {
    const { args, extraEnv } = pgDumpArgs({
      DATABASE_URL: 'postgresql://ngrid:x@dbhost:5432/ngrid',
      DB_PASSWORD: 'p@ss#w$rd',
    });
    expect(args).toEqual([
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      '-h',
      'dbhost',
      '-p',
      '5432',
      '-U',
      'ngrid',
      '-d',
      'ngrid',
    ]);
    expect(extraEnv).toEqual({ PGPASSWORD: 'p@ss#w$rd' });
  });

  it('prepends the clean-restore flags before a URL conninfo arg', () => {
    const { args, extraEnv } = pgDumpArgs({
      DATABASE_URL: 'postgresql://ngrid:pw@db:5432/ngrid?schema=public',
    });
    expect(args).toEqual([
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      'postgresql://ngrid:pw@db:5432/ngrid',
    ]);
    expect(extraEnv).toEqual({});
  });
});
