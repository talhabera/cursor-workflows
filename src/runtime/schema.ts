import { Ajv } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

export function validateJsonSchema(
  schema: Record<string, unknown>,
  data: unknown,
): { ok: true; data: unknown } | { ok: false; errors: string } {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (valid) {
    return { ok: true, data };
  }
  const errors = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
  return { ok: false, errors: errors || "schema validation failed" };
}

export function jsonSchemaToToolInput(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === "object" || schema.properties) {
    return schema;
  }
  return {
    type: "object",
    properties: { value: schema },
    required: ["value"],
  };
}

export function unwrapToolResult(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): unknown {
  if (schema.type === "object" || schema.properties) {
    return args;
  }
  return "value" in args ? args.value : args;
}
