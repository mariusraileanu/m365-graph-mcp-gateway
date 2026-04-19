export function normalizeObjectId(value: string): string {
  return value.trim().toLowerCase();
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseObjectId(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeObjectId(value);
  return isObjectId(normalized) ? normalized : null;
}
