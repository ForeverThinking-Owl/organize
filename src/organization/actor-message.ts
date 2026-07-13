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
  status: ActorMessageStatus;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
}

export type SendActorMessageInput = Pick<
  ActorMessage,
  "fromActorId" | "toActorId" | "type" | "payload"
>;

const MESSAGE_TYPES = new Set<ActorMessageType>([
  "task_request",
  "task_response",
  "information",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ActorInbox {
  private messages = new Map<string, ActorMessage>();
  private inboxOrder = new Map<string, string[]>();

  constructor(public readonly organizationId: string) {}

  send(input: SendActorMessageInput): ActorMessage {
    assertJsonSafe(input, "message");
    if (
      typeof input.fromActorId !== "string" ||
      input.fromActorId.length === 0 ||
      typeof input.toActorId !== "string" ||
      input.toActorId.length === 0 ||
      !MESSAGE_TYPES.has(input.type)
    ) {
      throw new OrganizationError("invalid_input", "Message has invalid sender, recipient, or type");
    }
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

  dumpInboxOrder(): Record<string, string[]> {
    return Object.fromEntries(
      Array.from(this.inboxOrder.entries(), ([actorId, order]) => [actorId, [...order]])
    );
  }

  restore(messages: ActorMessage[], inboxOrder: Record<string, string[]>): void {
    this.messages.clear();
    for (const message of messages) {
      if (message.organizationId !== this.organizationId) {
        throw new OrganizationError("cross_organization", "Message snapshot crosses organizations");
      }
      if (this.messages.has(message.messageId)) {
        throw new OrganizationError("invalid_input", `Duplicate message ${message.messageId} in snapshot`);
      }
      if (
        typeof message.messageId !== "string" ||
        message.messageId.length === 0 ||
        typeof message.fromActorId !== "string" ||
        typeof message.toActorId !== "string" ||
        typeof message.createdAt !== "string" ||
        !["task_request", "task_response", "information"].includes(message.type) ||
        !["queued", "delivered", "acknowledged"].includes(message.status) ||
        (message.deliveredAt !== undefined && typeof message.deliveredAt !== "string") ||
        (message.acknowledgedAt !== undefined && typeof message.acknowledgedAt !== "string") ||
        (message.status === "queued" &&
          (message.deliveredAt !== undefined || message.acknowledgedAt !== undefined)) ||
        (message.status === "delivered" &&
          (!message.deliveredAt || message.acknowledgedAt !== undefined)) ||
        (message.status === "acknowledged" &&
          (!message.deliveredAt || !message.acknowledgedAt))
      ) {
        throw new OrganizationError(
          "invalid_input",
          `Message ${String(message.messageId)} has invalid lifecycle fields`
        );
      }
      assertJsonSafe(message.payload, `message ${message.messageId}.payload`);
      this.messages.set(message.messageId, clone(message));
    }
    const referenced = new Set<string>();
    for (const [actorId, order] of Object.entries(inboxOrder)) {
      if (
        new Set(order).size !== order.length ||
        order.some((id) => {
          if (referenced.has(id)) return true;
          referenced.add(id);
          return this.messages.get(id)?.toActorId !== actorId;
        })
      ) {
        throw new OrganizationError("invalid_input", `Inbox ${actorId} contains an invalid message reference`);
      }
    }
    if (referenced.size !== this.messages.size) {
      throw new OrganizationError("invalid_input", "Inbox order omits one or more messages");
    }
    this.inboxOrder = new Map(
      Object.entries(inboxOrder).map(([actorId, order]) => [actorId, [...order]])
    );
  }
}
