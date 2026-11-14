export function resolveJwtSecret(
  _nodeEnv: string | undefined,
  rawSecret: string | undefined
): string {
  if (!rawSecret || rawSecret.trim().length < 32)
    throw new Error('JWT_SECRET must contain at least 32 characters');
  return rawSecret.trim();
}

export function shouldSeedDemoUser(
  nodeEnv: string | undefined,
  seedFlag: string | undefined
): boolean {
  return nodeEnv !== 'production' && seedFlag === 'true';
}
