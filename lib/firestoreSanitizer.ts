/**
 * Recursively strips `undefined` values from any object or array payload
 * before writing to Firestore (`setDoc`, `updateDoc`, `batch.set`),
 * converting top-level or nested `undefined` keys to omitted keys and
 * preserving `null`, primitives, arrays, and plain objects.
 */
export function sanitizeFirestorePayload<T>(obj: T): T {
  if (typeof obj === 'number' && Number.isNaN(obj)) {
    return null as unknown as T;
  }

  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj
      .map((item) =>
        item === undefined || (typeof item === 'number' && Number.isNaN(item))
          ? null
          : sanitizeFirestorePayload(item)
      )
      .filter((item) => item !== undefined) as unknown as T;
  }

  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) {
    return obj;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) {
      if (typeof value === 'number' && Number.isNaN(value)) {
        cleaned[key] = null;
      } else {
        cleaned[key] =
          value !== null && typeof value === 'object'
            ? sanitizeFirestorePayload(value)
            : value;
      }
    }
  }
  return cleaned as T;
}

