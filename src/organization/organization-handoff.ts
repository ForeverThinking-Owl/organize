import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OrganizationError } from "./organization-error";
import { assertJsonSafe } from "./organization-permission";

export type OrganizationHandoffStatus = "requested" | "responded";

export interface OrganizationHandoffRecord {
  organizationId: string;
  handoffRequestId: string;
  sourceTaskId: string;
  sourceActorId: string;
  childTaskId: string;
  targetActorId: string;
  targetSkillId: string;
  requestMessageId: string;
  responseMessageId?: string;
  fingerprint: string;
  status: OrganizationHandoffStatus;
  createdAt: string;
  respondedAt?: string;
}

export type CreateOrganizationHandoffInput = Pick<
  OrganizationHandoffRecord,
  | "handoffRequestId"
  | "sourceTaskId"
  | "sourceActorId"
  | "childTaskId"
  | "targetActorId"
  | "targetSkillId"
  | "requestMessageId"
  | "fingerprint"
>;

const HANDOFF_FIELDS = new Set([
  "organizationId", "handoffRequestId", "sourceTaskId", "sourceActorId", "childTaskId",
  "targetActorId", "targetSkillId", "requestMessageId", "responseMessageId", "fingerprint",
  "status", "createdAt", "respondedAt",
]);
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrganizationError("invalid_input", `${path} must be a non-empty string`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

/** Produces a deterministic idempotency fingerprint for a JSON-safe handoff envelope. */
export function computeOrganizationHandoffFingerprint(envelope: Record<string, unknown>): string {
  if (!isPlainRecord(envelope)) {
    throw new OrganizationError("invalid_input", "Handoff fingerprint envelope must be a plain object");
  }
  assertJsonSafe(envelope, "handoff fingerprint envelope");
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

export function assertOrganizationHandoffRecord(
  value: unknown,
  expectedOrganizationId?: string
): asserts value is OrganizationHandoffRecord {
  if (!isPlainRecord(value) || Object.keys(value).some((field) => !HANDOFF_FIELDS.has(field))) {
    throw new OrganizationError("invalid_input", "Handoff record has unsupported fields");
  }
  for (const field of [
    "organizationId", "handoffRequestId", "sourceTaskId", "sourceActorId", "childTaskId",
    "targetActorId", "targetSkillId", "requestMessageId", "fingerprint", "createdAt",
  ] as const) {
    assertNonEmptyString(value[field], `handoff.${field}`);
  }
  if (expectedOrganizationId !== undefined && value.organizationId !== expectedOrganizationId) {
    throw new OrganizationError("cross_organization", "Handoff snapshot crosses organizations");
  }
  if (!SHA_256_PATTERN.test(value.fingerprint as string)) {
    throw new OrganizationError(
      "invalid_input",
      `Handoff ${value.handoffRequestId} has an invalid fingerprint`
    );
  }
  if (value.sourceActorId === value.targetActorId) {
    throw new OrganizationError("invalid_input", `Handoff ${value.handoffRequestId} targets its source actor`);
  }
  if (value.sourceTaskId === value.childTaskId) {
    throw new OrganizationError("invalid_input", `Handoff ${value.handoffRequestId} reuses its source task`);
  }
  if (value.status !== "requested" && value.status !== "responded") {
    throw new OrganizationError("invalid_input", `Handoff ${value.handoffRequestId} has invalid status`);
  }
  if (value.responseMessageId !== undefined) {
    assertNonEmptyString(value.responseMessageId, "handoff.responseMessageId");
  }
  if (value.respondedAt !== undefined) {
    assertNonEmptyString(value.respondedAt, "handoff.respondedAt");
  }
  if (
    (value.status === "requested" &&
      (value.responseMessageId !== undefined || value.respondedAt !== undefined)) ||
    (value.status === "responded" &&
      (value.responseMessageId === undefined || value.respondedAt === undefined))
  ) {
    throw new OrganizationError(
      "invalid_input",
      `Handoff ${value.handoffRequestId} has inconsistent response fields`
    );
  }
}

export function cloneOrganizationHandoffRecord(
  record: OrganizationHandoffRecord
): OrganizationHandoffRecord {
  return clone(record);
}

export class OrganizationHandoffRegistry {
  private records = new Map<string, OrganizationHandoffRecord>();

  constructor(public readonly organizationId: string) {}

  create(input: CreateOrganizationHandoffInput): OrganizationHandoffRecord {
    if (!isPlainRecord(input)) {
      throw new OrganizationError("invalid_input", "Handoff input must be a plain object");
    }
    const allowedFields = new Set([
      "handoffRequestId", "sourceTaskId", "sourceActorId", "childTaskId", "targetActorId",
      "targetSkillId", "requestMessageId", "fingerprint",
    ]);
    if (Object.keys(input).some((field) => !allowedFields.has(field))) {
      throw new OrganizationError("invalid_input", "Handoff input has unsupported fields");
    }
    const record: OrganizationHandoffRecord = {
      ...clone(input),
      organizationId: this.organizationId,
      status: "requested",
      createdAt: new Date().toISOString(),
    };
    assertOrganizationHandoffRecord(record, this.organizationId);

    const existing = this.records.get(record.handoffRequestId);
    if (existing) {
      const existingInput: CreateOrganizationHandoffInput = {
        handoffRequestId: existing.handoffRequestId,
        sourceTaskId: existing.sourceTaskId,
        sourceActorId: existing.sourceActorId,
        childTaskId: existing.childTaskId,
        targetActorId: existing.targetActorId,
        targetSkillId: existing.targetSkillId,
        requestMessageId: existing.requestMessageId,
        fingerprint: existing.fingerprint,
      };
      if (!isDeepStrictEqual(existingInput, input)) {
        throw new OrganizationError(
          "already_exists",
          `Handoff ${record.handoffRequestId} already exists with a different fingerprint or route`
        );
      }
      return clone(existing);
    }
    this.records.set(record.handoffRequestId, record);
    return clone(record);
  }

  bindResponse(handoffRequestId: string, responseMessageId: string): OrganizationHandoffRecord {
    assertNonEmptyString(handoffRequestId, "handoffRequestId");
    assertNonEmptyString(responseMessageId, "responseMessageId");
    const record = this.records.get(handoffRequestId);
    if (!record) {
      throw new OrganizationError("not_found", `Handoff ${handoffRequestId} was not found`);
    }
    if (record.status === "responded") {
      if (record.responseMessageId !== responseMessageId) {
        throw new OrganizationError(
          "already_exists",
          `Handoff ${handoffRequestId} already has a different response`
        );
      }
      return clone(record);
    }
    const responded: OrganizationHandoffRecord = {
      ...record,
      responseMessageId,
      status: "responded",
      respondedAt: new Date().toISOString(),
    };
    this.records.set(handoffRequestId, responded);
    return clone(responded);
  }

  find(handoffRequestId: string): OrganizationHandoffRecord | null {
    const record = this.records.get(handoffRequestId);
    return record ? clone(record) : null;
  }

  get(handoffRequestId: string): OrganizationHandoffRecord {
    const record = this.find(handoffRequestId);
    if (!record) throw new OrganizationError("not_found", `Handoff ${handoffRequestId} was not found`);
    return record;
  }

  list(): OrganizationHandoffRecord[] {
    return Array.from(this.records.values(), clone);
  }

  restore(records: OrganizationHandoffRecord[]): void {
    const restored = new Map<string, OrganizationHandoffRecord>();
    const taskIds = new Set<string>();
    const requestMessageIds = new Set<string>();
    const responseMessageIds = new Set<string>();
    for (const record of records) {
      assertOrganizationHandoffRecord(record, this.organizationId);
      if (restored.has(record.handoffRequestId)) {
        throw new OrganizationError(
          "invalid_input",
          `Duplicate handoff ${record.handoffRequestId} in snapshot`
        );
      }
      if (taskIds.has(record.sourceTaskId) || taskIds.has(record.childTaskId)) {
        throw new OrganizationError("invalid_input", "Handoff snapshot reuses a source or child task");
      }
      if (requestMessageIds.has(record.requestMessageId)) {
        throw new OrganizationError("invalid_input", "Handoff snapshot reuses a request message");
      }
      if (record.responseMessageId && responseMessageIds.has(record.responseMessageId)) {
        throw new OrganizationError("invalid_input", "Handoff snapshot reuses a response message");
      }
      taskIds.add(record.sourceTaskId);
      taskIds.add(record.childTaskId);
      requestMessageIds.add(record.requestMessageId);
      if (record.responseMessageId) responseMessageIds.add(record.responseMessageId);
      restored.set(record.handoffRequestId, clone(record));
    }
    this.records = restored;
  }
}
