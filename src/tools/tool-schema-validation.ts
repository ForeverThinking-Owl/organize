function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[]
): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must match one of the allowed values`);
  }

  if (typeof schema.type === "string") {
    const type = actualType(value);
    const matches =
      schema.type === type ||
      (schema.type === "number" && (type === "number" || type === "integer"));
    if (!matches) {
      errors.push(`${path} expected ${schema.type}, got ${type}`);
      return;
    }
  }

  if (schema.type === "object" && isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const field of required) {
      if (typeof field === "string" && !Object.prototype.hasOwnProperty.call(value, field)) {
        errors.push(`${path}.${field} is required`);
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [field, propertySchema] of Object.entries(properties)) {
      if (field in value && isRecord(propertySchema)) {
        validateValue(value[field], propertySchema, `${path}.${field}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (!(field in properties)) errors.push(`${path}.${field} is not allowed`);
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => validateValue(item, schema.items as Record<string, unknown>, `${path}[${index}]`, errors));
  }
}

export function validateToolArguments(
  arguments_: Record<string, unknown>,
  schema?: Record<string, unknown>
): string[] {
  if (!schema) return [];
  const errors: string[] = [];
  validateValue(arguments_, schema, "arguments", errors);
  return errors;
}

export function validateToolOutput(
  output: unknown,
  schema?: Record<string, unknown>
): string[] {
  if (!schema) return [];
  const errors: string[] = [];
  validateValue(output, schema, "output", errors);
  return errors;
}
