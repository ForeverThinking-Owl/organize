import { randomUUID } from "node:crypto";
import { OrganizationError } from "./organization-error";
import { assertJsonSafe } from "./organization-permission";

export type ActorMessageType = "task_request" | "task_response" | "information";
export type ActorMessageStatus = "queued" | "delivered" | "acknowledged";

export interface ActorMessage {
  organizationId: string;
  messageId: string;
  fromActorId: string;
  toActorId: string;
  type: ActorMessageType;
  payload: unknown;
  correlationId?: string;
  causationMessageId?: string;
  status: ActorMessageStatus;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
}

export type SendActorMessageInput = Pick<
  ActorMessage,
  "fromActorId" | "toActorId" | "type" | "payload"
>;

export interface SendInternalActorMessageInput extends SendActorMessageInput {
  type: Extract<ActorMessageType, "task_request" | "task_response">;
  correlationId: string;
  causationMessageId?: string;
}

const MESSAGE_TYPES = new Set<ActorMessageType>([
  "task_request",
  "task_response",
  "information",
]);
const MESSAGE_STATUSES = new Set<ActorMessageStatus>(["queued", "delivered", "acknowledged"]);
const MESSAGE_FIELDS = new Set([
  "organizationId", "messageId", "fromActorId", "toActorId", "type", "payload",
  "correlationId", "causationMessageId", "status", "createdAt", "deliveredAt",
  "acknowledgedAt",
]);

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

function assertMessageEndpoints(input: SendActorMessageInput): void {
  if (
    typeof input.fromActorId !== "string" ||
    input.fromActorId.length === 0 ||
    typeof input.toActorId !== "string" ||
    input.toActorId.length === 0 ||
    !MESSAGE_TYPES.has(input.type)
  ) {
    throw new OrganizationError("invalid_input", "Message has invalid sender, recipient, or type");
  }
  assertJsonSafe(input.payload, "message.payload");
}

export function assertActorMessage(
  value: unknown,
  expectedOrganizationId?: string
): asserts value is ActorMessage {
  if (!isPlainRecord(value) || Object.keys(value).some((field) => !MESSAGE_FIELDS.has(field))) {
    throw new OrganizationError("invalid_input", "Message must be a plain object with supported fields");
  }
  for (const field of [
    "organizationId", "messageId", "fromActorId", "toActorId", "createdAt",
  ] as const) {
    assertNonEmptyString(value[field], `message.${field}`);
  }
  if (expectedOrganizationId !== undefined && value.organizationId !== expectedOrganizationId) {
    throw new OrganizationError("cross_organization", "Message snapshot crosses organizations");
  }
  if (!MESSAGE_TYPES.has(value.type as ActorMessageType) || !MESSAGE_STATUSES.has(value.status as ActorMessageStatus)) {
    throw new OrganizationError("invalid_input", `Message ${value.messageId} has an invalid type or status`);
  }
  for (const field of [
    "correlationId", "causationMessageId", "deliveredAt", "acknowledgedAt",
  ] as const) {
    if (value[field] !== undefined) assertNonEmptyString(value[field], `message.${field}`);
  }
  if (
    (value.status === "queued" &&
      (value.deliveredAt !== undefined || value.acknowledgedAt !== undefined)) ||
    (value.status === "delivered" &&
      (value.deliveredAt === undefined || value.acknowledgedAt !== undefined)) ||
    (value.status === "acknowledged" &&
      (value.deliveredAt === undefined || value.acknowledgedAt === undefined))
  ) {
    throw new OrganizationError(
      "invalid_input",
      `Message ${value.messageId} has invalid lifecycle fields`
    );
  }
  const hasInternalMetadata = value.correlationId !== undefined || value.causationMessageId !== undefined;
  if (hasInternalMetadata) {
    if (value.type === "task_request") {
      if (value.correlationId === undefined || value.causationMessageId !== undefined) {
        throw new OrganizationError("invalid_input", `Task request ${value.messageId} has invalid correlation`);
      }
    } else if (value.type === "task_response") {
      if (value.correlationId === undefined || value.causationMessageId === undefined) {
        throw new OrganizationError("invalid_input", `Task response ${value.messageId} has invalid causation`);
      }
    } else {
      throw new OrganizationError("invalid_input", `Information message ${value.messageId} cannot be correlated`);
    }
  }
  assertJsonSafe(value.payload, `message ${value.messageId}.payload`);
}

export function cloneActorMessage(message: ActorMessage): ActorMessage {
  return clone(message);
}

export class ActorInbox {
  private messages = new Map<string, ActorMessage>();
  private inboxOrder = new Map<string, string[]>();

  constructor(public readonly organizationId: string) {}

  send(input: SendActorMessageInput): ActorMessage {
    if (!isPlainRecord(input)) {
      throw new OrganizationError("invalid_input", "Message must be a plain object");
    }
    assertMessageEndpoints(input);
    if (Object.keys(input).some((field) =>
      !["fromActorId", "toActorId", "type", "payload"].includes(field)
    )) {
      throw new OrganizationError("invalid_input", "Message has unsupported fields");
    }
    const message: ActorMessage = {
      ...clone(input),
      organizationId: this.organizationId,
      messageId: `msg_${randomUUID()}`,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.messages.set(message.messageId, message);
    const order = this.inboxOrder.get(message.toActorId) ?? [];
    order.push(message.messageId);
    this.inboxOrder.set(message.toActorId, order);
    return clone(message);
  }

  sendInternal(input: SendInternalActorMessageInput): ActorMessage {
    if (!isPlainRecord(input)) {
      throw new OrganizationError("invalid_input", "Internal message must be a plain object");
    }
    const allowedFields = new Set([
      "fromActorId", "toActorId", "type", "payload", "correlationId", "causationMessageId",
    ]);
    if (Object.keys(input).some((field) => !allowedFields.has(field))) {
      throw new OrganizationError("invalid_input", "Internal message has unsupported fields");
    }
    assertMessageEndpoints(input);
    if (input.type !== "task_request" && input.type !== "task_response") {
      throw new OrganizationError("invalid_input", "Internal message must be a task request or response");
    }
    assertNonEmptyString(input.correlationId, "message.correlationId");
    if (input.type === "task_request") {
      if (input.causationMessageId !== undefined) {
        throw new OrganizationError("invalid_input", "Task request cannot have a causation message");
      }
    } else {
      assertNonEmptyString(input.causationMessageId, "message.causationMessageId");
      const cause = this.messages.get(input.causationMessageId);
      if (
        !cause ||
        cause.type !== "task_request" ||
        cause.correlationId !== input.correlationId ||
        cause.fromActorId !== input.toActorId ||
        cause.toActorId !== input.fromActorId
      ) {
        throw new OrganizationError("invalid_input", "Task response has invalid causation");
      }
    }
    const message: ActorMessage = {
      ...clone(input),
      organizationId: this.organizationId,
      messageId: `msg_${randomUUID()}`,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.messages.set(message.messageId, message);
    const order = this.inboxOrder.get(message.toActorId) ?? [];
    order.push(message.messageId);
    this.inboxOrder.set(message.toActorId, order);
    return clone(message);
  }

  deliverNext(actorId: string): ActorMessage | null {
    const order = this.inboxOrder.get(actorId) ?? [];
    const messageId = order.find((id) => this.messages.get(id)?.status !== "acknowledged");
    if (!messageId) return null;
    const message = this.messages.get(messageId)!;
    if (message.status === "queued") {
      const delivered = { ...message, status: "delivered" as const, deliveredAt: new Date().toISOString() };
      this.messages.set(messageId, delivered);
      return clone(delivered);
    }
    return clone(message);
  }

  deliver(actorId: string, messageId: string): ActorMessage {
    const message = this.messages.get(messageId);
    if (!message || message.toActorId !== actorId) {
      throw new OrganizationError("not_found", `Message ${messageId} was not found in actor ${actorId} inbox`);
    }
    if (message.status === "acknowledged") {
      throw new OrganizationError("invalid_state", `Message ${messageId} is already acknowledged`);
    }
    if (message.status === "delivered") return clone(message);
    const delivered = {
      ...message,
      status: "delivered" as const,
      deliveredAt: new Date().toISOString(),
    };
    this.messages.set(messageId, delivered);
    return clone(delivered);
  }

  acknowledge(actorId: string, messageId: string): ActorMessage {
    const message = this.messages.get(messageId);
    if (!message || message.toActorId !== actorId) {
      throw new OrganizationError("not_found", `Message ${messageId} was not found in actor ${actorId} inbox`);
    }
    if (message.status !== "delivered") {
      throw new OrganizationError("invalid_state", `Message ${messageId} is not delivered`);
    }
    const acknowledged = {
      ...message,
      status: "acknowledged" as const,
      acknowledgedAt: new Date().toISOString(),
    };
    this.messages.set(messageId, acknowledged);
    return clone(acknowledged);
  }

  listInbox(actorId: string): ActorMessage[] {
    return (this.inboxOrder.get(actorId) ?? [])
      .map((id) => this.messages.get(id))
      .filter((message): message is ActorMessage => Boolean(message))
      .map(clone);
  }

  listAll(): ActorMessage[] {
    return Array.from(this.messages.values(), clone);
  }

  list(): ActorMessage[] {
    return this.listAll();
  }

  get(messageId: string): ActorMessage {
    const message = this.messages.get(messageId);
    if (!message) throw new OrganizationError("not_found", `Message ${messageId} was not found`);
    return clone(message);
  }

  dumpInboxOrder(): Record<string, string[]> {
    return Object.fromEntries(
      Array.from(this.inboxOrder.entries(), ([actorId, order]) => [actorId, [...order]])
    );
  }

  restore(messages: ActorMessage[], inboxOrder: Record<string, string[]>): void {
    const nextMessages = new Map<string, ActorMessage>();
    for (const message of messages) {
      assertActorMessage(message, this.organizationId);
      if (nextMessages.has(message.messageId)) {
        throw new OrganizationError("invalid_input", `Duplicate message ${message.messageId} in snapshot`);
      }
      nextMessages.set(message.messageId, clone(message));
    }
    const referenced = new Set<string>();
    for (const [actorId, order] of Object.entries(inboxOrder)) {
      if (
        new Set(order).size !== order.length ||
        order.some((id) => {
          if (referenced.has(id)) return true;
          referenced.add(id);
          return nextMessages.get(id)?.toActorId !== actorId;
        })
      ) {
        throw new OrganizationError("invalid_input", `Inbox ${actorId} contains an invalid message reference`);
      }
    }
    if (referenced.size !== nextMessages.size) {
      throw new OrganizationError("invalid_input", "Inbox order omits one or more messages");
    }
    for (const message of nextMessages.values()) {
      if (!message.causationMessageId) continue;
      const cause = nextMessages.get(message.causationMessageId);
      if (
        !cause ||
        cause.type !== "task_request" ||
        cause.correlationId !== message.correlationId ||
        cause.fromActorId !== message.toActorId ||
        cause.toActorId !== message.fromActorId
      ) {
        throw new OrganizationError("invalid_input", `Message ${message.messageId} has invalid causation`);
      }
    }
    this.messages = nextMessages;
    this.inboxOrder = new Map(
      Object.entries(inboxOrder).map(([actorId, order]) => [actorId, [...order]])
    );
  }
}
