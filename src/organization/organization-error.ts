export type OrganizationErrorCode =
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "invalid_state"
  | "invalid_input"
  | "cross_organization";

export class OrganizationError extends Error {
  constructor(
    public readonly code: OrganizationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OrganizationError";
  }
}
