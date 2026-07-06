// ============================================================================
// Structured Output Validator
// v0.2.0: 轻量 JSON Schema 校验，后续可替换为 Ajv
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateStructuredOutput(
  data: unknown,
  schema: Record<string, unknown>
): ValidationResult {
  const errors: string[] = [];
  validateValue(data, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[]
): void {
  const type = schema.type as string | undefined;

  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} should be object`);
      return;
    }

    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (key in obj) {
          validateValue(obj[key], childSchema, `${path}.${key}`, errors);
        }
      }
    }
    return;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} should be array`);
      return;
    }
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (itemSchema) {
      value.forEach((item, index) => validateValue(item, itemSchema, `${path}[${index}]`, errors));
    }
    return;
  }

  if (type === "string") {
    if (typeof value !== "string") errors.push(`${path} should be string`);
  }

  if (type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} should be boolean`);
  }

  if (type === "number") {
    if (typeof value !== "number") errors.push(`${path} should be number`);
  }

  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues && !enumValues.includes(value)) {
    errors.push(`${path} should be one of ${JSON.stringify(enumValues)}`);
  }
}
