// Builds inputs for a tool from its input schema, without any AI.
// "good" inputs follow the schema; "bad" inputs deliberately break it.

type Schema = Record<string, any>;

function sampleValue(schema: Schema | undefined, name: string): unknown {
  if (!schema || typeof schema !== 'object') return 'test';
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const variant = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (variant) return sampleValue(variant, name);

  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type;
  switch (type) {
    case 'integer':
    case 'number':
      return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 1);
    case 'boolean':
      return false;
    case 'array':
      return schema.minItems ? [sampleValue(schema.items, name)] : [];
    case 'object':
      return sampleObject(schema);
    default:
      return sampleString(schema, name);
  }
}

function sampleString(schema: Schema, name: string): string {
  if (schema.format === 'uri' || /url|uri|link/i.test(name)) return 'https://example.com';
  if (schema.format === 'email' || /email/i.test(name)) return 'test@example.com';
  if (schema.format === 'date') return '2026-01-01';
  if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
  const text = 'test';
  return schema.minLength && schema.minLength > text.length ? text.padEnd(schema.minLength, 'x') : text;
}

// Only required fields are filled: the smallest input that should still work.
function sampleObject(schema: Schema): Record<string, unknown> {
  const props: Record<string, Schema> = schema.properties ?? {};
  const required: string[] = schema.required ?? [];
  const out: Record<string, unknown> = {};
  for (const key of required) out[key] = sampleValue(props[key], key);
  return out;
}

export function goodArgs(inputSchema: Schema): Record<string, unknown> {
  return sampleObject(inputSchema);
}

export interface BadCase {
  label: string;
  args: Record<string, unknown>;
}

// Inputs a server should refuse with a clear error.
export function badArgs(inputSchema: Schema): BadCase[] {
  const props: Record<string, Schema> = inputSchema.properties ?? {};
  const required: string[] = inputSchema.required ?? [];
  const cases: BadCase[] = [];

  // An input with a default can be left out: the tool filling it in is correct, not a fault.
  const mustSend = required.filter((k) => props[k]?.default === undefined);
  if (mustSend.length) cases.push({ label: `missing required input "${mustSend[0]}"`, args: {} });

  // Prefer an input with no default: a tool may fairly fall back to the default for a bad value.
  const keys = [...required, ...Object.keys(props).filter((k) => !required.includes(k))];
  const typed = keys.find((k) => props[k]?.type && props[k]?.default === undefined) ?? keys.find((k) => props[k]?.type);
  if (typed) {
    const type = props[typed].type;
    const wrong = type === 'string' ? 12345 : 'not-a-' + (Array.isArray(type) ? type[0] : type);
    cases.push({ label: `wrong type for "${typed}"`, args: { ...goodArgs(inputSchema), [typed]: wrong } });
  }
  return cases;
}
