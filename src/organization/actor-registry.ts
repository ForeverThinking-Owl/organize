import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import { OrganizationError } from "./organization-error";
import {
  assertCapability,
  isOrganizationCapability,
  type OrganizationCapability,
} from "./organization-permission";

export interface RegisteredActor {
  organizationId: string;
  actorId: string;
  status: "active" | "inactive";
  actorConfig: ActorConfig;
  skills: Record<string, SkillConfig>;
  capabilities: OrganizationCapability[];
  registeredAt: string;
}

export interface RegisterActorInput {
  actorConfig: ActorConfig;
  skills: SkillConfig[];
  capabilities: OrganizationCapability[];
  status?: "active" | "inactive";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ActorRegistry {
  private actors = new Map<string, RegisteredActor>();

  constructor(public readonly organizationId: string) {}

  register(input: RegisterActorInput): RegisteredActor {
    const actorId = input.actorConfig.actor_id;
    if (input.actorConfig.organization_id !== this.organizationId) {
      throw new OrganizationError(
        "cross_organization",
        `Actor ${actorId} does not belong to organization ${this.organizationId}`
      );
    }
    if (this.actors.has(actorId)) {
      throw new OrganizationError("already_exists", `Actor ${actorId} is already registered`);
    }
    if (input.capabilities.some((capability) => !isOrganizationCapability(capability))) {
      throw new OrganizationError("invalid_input", `Actor ${actorId} has an unknown capability`);
    }

    const allowedSkills = new Set(input.actorConfig.permissions.allowed_skills ?? []);
    const skills: Record<string, SkillConfig> = {};
    for (const skill of input.skills) {
      if (skill.owner_actor_id && skill.owner_actor_id !== actorId) {
        throw new OrganizationError(
          "invalid_input",
          `Skill ${skill.skill_id} is owned by ${skill.owner_actor_id}, not ${actorId}`
        );
      }
      if (!allowedSkills.has(skill.skill_id)) {
        throw new OrganizationError(
          "permission_denied",
          `Skill ${skill.skill_id} is not allowed for actor ${actorId}`
        );
      }
      if (skills[skill.skill_id]) {
        throw new OrganizationError("invalid_input", `Duplicate skill ${skill.skill_id}`);
      }
      skills[skill.skill_id] = clone(skill);
    }

    const actor: RegisteredActor = {
      organizationId: this.organizationId,
      actorId,
      status: input.status ?? "active",
      actorConfig: clone(input.actorConfig),
      skills,
      capabilities: [...new Set(input.capabilities)],
      registeredAt: new Date().toISOString(),
    };
    this.actors.set(actorId, actor);
    return clone(actor);
  }

  require(actorId: string): RegisteredActor {
    const actor = this.actors.get(actorId);
    if (!actor) throw new OrganizationError("not_found", `Actor ${actorId} was not found`);
    return clone(actor);
  }

  requireActive(actorId: string): RegisteredActor {
    const actor = this.require(actorId);
    if (actor.status !== "active") {
      throw new OrganizationError("permission_denied", `Actor ${actorId} is inactive`);
    }
    return actor;
  }

  requireCapability(actorId: string, capability: OrganizationCapability): RegisteredActor {
    const actor = this.require(actorId);
    assertCapability(actor, capability);
    return actor;
  }

  getSkill(actorId: string, skillId: string): SkillConfig {
    const actor = this.requireActive(actorId);
    const skill = actor.skills[skillId];
    if (!skill) {
      throw new OrganizationError(
        "permission_denied",
        `Actor ${actorId} cannot execute skill ${skillId}`
      );
    }
    return clone(skill);
  }

  list(): RegisteredActor[] {
    return Array.from(this.actors.values(), clone);
  }

  restore(actors: RegisteredActor[]): void {
    this.actors.clear();
    for (const actor of actors) {
      if (actor.organizationId !== this.organizationId) {
        throw new OrganizationError("cross_organization", "Actor snapshot crosses organizations");
      }
      if (
        actor.actorConfig.organization_id !== this.organizationId ||
        actor.actorConfig.actor_id !== actor.actorId ||
        !["active", "inactive"].includes(actor.status) ||
        actor.capabilities.some((capability) => !isOrganizationCapability(capability))
      ) {
        throw new OrganizationError("invalid_input", `Actor ${actor.actorId} has inconsistent config identity`);
      }
      const allowedSkills = new Set(actor.actorConfig.permissions.allowed_skills ?? []);
      const restoredSkillIds = new Set<string>();
      for (const [skillId, skill] of Object.entries(actor.skills)) {
        if (skillId !== skill.skill_id || restoredSkillIds.has(skill.skill_id)) {
          throw new OrganizationError("invalid_input", `Actor ${actor.actorId} has inconsistent Skill ids`);
        }
        restoredSkillIds.add(skill.skill_id);
        if (!allowedSkills.has(skill.skill_id)) {
          throw new OrganizationError("permission_denied", `Skill ${skill.skill_id} is not allowed`);
        }
        if (skill.owner_actor_id && skill.owner_actor_id !== actor.actorId) {
          throw new OrganizationError("invalid_input", `Skill ${skill.skill_id} has the wrong owner`);
        }
      }
      if (this.actors.has(actor.actorId)) {
        throw new OrganizationError("invalid_input", `Duplicate actor ${actor.actorId} in snapshot`);
      }
      this.actors.set(actor.actorId, clone(actor));
    }
  }
}
