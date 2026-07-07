// ============================================================================
// MemoryFingerprint
// v0.3.2: shared deterministic fingerprint utilities for memory observability
// ============================================================================

export interface FingerprintableMemory {
  organizationId?: string;
  unitId?: string;
  actorId?: string;
  sceneId?: string;
  scope: string;
  type: string;
  content: string;
  structuredData?: Record<string, unknown>;
}

export function normalizeMemoryText(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”‘’；：,.!！?？]/g, "");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

export function memoryFingerprint(input: FingerprintableMemory): string {
  const structured = input.structuredData ? stableStringify(input.structuredData) : "";
  return [
    input.organizationId ?? "",
    input.unitId ?? "",
    input.actorId ?? "",
    input.sceneId ?? "",
    input.scope,
    input.type,
    normalizeMemoryText(input.content),
    structured,
  ].join("|");
}
