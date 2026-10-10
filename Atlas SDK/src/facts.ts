import canonicalize from "canonicalize";

// JCS ordering and primitive serialization belong to the pinned RFC 8785
// implementation. The boundary refuses values JSON would silently transform.
export function canonicalJSON(value: unknown): Uint8Array {
  requireJSON(value, new Set(), 0);
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new Error("Signed fact is not a JSON value");
  return new TextEncoder().encode(canonical);
}
function requireJSON(value: unknown, ancestors: Set<object>, depth: number): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || depth > 128 || ancestors.has(value))
    throw new Error("Signed fact is not bounded JSON");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Signed fact is not plain JSON");
  ancestors.add(value);
  for (const child of Array.isArray(value) ? Array.from(value) : Object.values(value))
    requireJSON(child, ancestors, depth + 1);
  ancestors.delete(value);
}

export async function digest(bytes: Uint8Array): Promise<string> {
  // Copy into an owned ArrayBuffer accepted by browser and Node WebCrypto.
  return base64URL(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)));
}

export function base64URL(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
