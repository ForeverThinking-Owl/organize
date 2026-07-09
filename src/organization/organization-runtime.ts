// ============================================================================
// Organization Runtime
// v0.5.0: coordinates actors, tasks, and messages
// ============================================================================

import type { Organization } from "./organization";
import { createOrganization } from "./organization";
import { actorRegistry, type RegisteredActor } from "./actor-registry";
import { createActorMessage, type ActorMessage, type ActorMessageType } from "./actor-message";
import { taskManager, type Task } from "./task";
import { organizationTrace } from "./organization-trace";

export class OrganizationRuntime {
  private organization: Organization | null = null;

  create(name: string): Organization {
    this.organization = createOrganization(name);
    organizationTrace.record("organization_created", {
      organizationId: this.organization.organizationId,
    });
    return this.organization;
  }

  registerActor(actor: RegisteredActor): void {
    actorRegistry.register(actor);
    if (this.organization && !this.organization.actorIds.includes(actor.actorId)) {
      this.organization.actorIds.push(actor.actorId);
    }
    organizationTrace.record("actor_registered", {
      actorId: actor.actorId,
    });
  }

  createTask(input: Omit<Task, "taskId" | "status" | "createdAt">): Task {
    const task = taskManager.create(input);
    organizationTrace.record("task_created", {
      taskId: task.taskId,
      createdBy: task.createdBy,
    });
    return task;
  }

  assignTask(taskId: string, actorId: string): Task | null {
    const task = taskManager.assign(taskId, actorId);
    if (task) {
      organizationTrace.record("task_assigned", {
        taskId,
        actorId,
      });
    }
    return task;
  }

  sendMessage(
    fromActor: string,
    toActor: string,
    type: ActorMessageType,
    payload: unknown
  ): ActorMessage {
    const message = createActorMessage(fromActor, toActor, type, payload);
    organizationTrace.record("message_sent", {
      messageId: message.messageId,
      fromActor,
      toActor,
    });
    organizationTrace.record("message_received", {
      messageId: message.messageId,
      toActor,
    });
    return message;
  }

  completeTask(taskId: string): Task | null {
    const task = taskManager.complete(taskId);
    if (task) {
      organizationTrace.record("task_completed", { taskId });
    }
    return task;
  }
}

export const organizationRuntime = new OrganizationRuntime();
