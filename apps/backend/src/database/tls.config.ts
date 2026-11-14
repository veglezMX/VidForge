/** Remote database connections must verify the server certificate. */
export function databaseTls(
  url?: string,
  host?: string,
  tls?: string
): false | { rejectUnauthorized: true } {
  const hostname = url ? new URL(url).hostname : host || 'localhost';
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  if (!local && tls !== 'true')
    throw new Error('Remote databases require DB_TLS=true and a trusted certificate');
  return tls === 'true' ? { rejectUnauthorized: true } : false;
}
