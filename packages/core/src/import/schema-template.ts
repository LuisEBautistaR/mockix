/**
 * Builds a response template from a JSON Schema (OpenAPI): fake but plausible
 * data with faker and the generators, so an operation without examples still
 * answers something useful. Property names guide the choice (email, nombre…).
 */

type Schema = Record<string, unknown>;

const BY_NAME: Array<[RegExp, string]> = [
  [/^(e-?mail|correo)$/i, "{{faker 'internet.email'}}"],
  [/^(first_?name|nombre_?pila)$/i, "{{faker 'person.firstName'}}"],
  [/^(last_?name|apellidos?)$/i, "{{faker 'person.lastName'}}"],
  [/^(name|nombre|full_?name|nombre_?completo)$/i, "{{faker 'person.fullName'}}"],
  [/^(phone|telefono|tel|mobile|celular)$/i, "{{faker 'phone.number'}}"],
  [/^(city|ciudad)$/i, "{{faker 'location.city'}}"],
  [/^(country|pais)$/i, "{{faker 'location.country'}}"],
  [/^(address|direccion|street)$/i, "{{faker 'location.streetAddress'}}"],
  [/^(zip|postal_?code|cp|codigo_?postal)$/i, "{{faker 'location.zipCode'}}"],
  [/^(company|empresa)$/i, "{{faker 'company.name'}}"],
  [/^(title|titulo)$/i, "{{faker 'lorem.sentence'}}"],
  [/^(description|descripcion|summary|resumen)$/i, "{{faker 'lorem.sentence'}}"],
  [/^(product|producto|product_?name)$/i, "{{faker 'commerce.productName'}}"],
  [/^(url|website|sitio)$/i, "{{faker 'internet.url'}}"],
  [/^(username|usuario|login)$/i, "{{faker 'internet.username'}}"],
  [/^(avatar|image|imagen|foto|photo)$/i, "{{faker 'image.url'}}"],
  [/^(color|colour)$/i, "{{faker 'color.human'}}"],
];

const quote = (s: string) => `"${s}"`;

function stringFor(schema: Schema, name: string): string {
  if (Array.isArray(schema["enum"]) && schema["enum"].length) {
    return quote(`{{oneOf ${schema["enum"].map((v) => `'${String(v).replace(/'/g, "")}'`).join(" ")}}}`);
  }
  switch (schema["format"]) {
    case "email":
      return quote("{{faker 'internet.email'}}");
    case "uuid":
      return quote("{{uuid}}");
    case "date-time":
      return quote("{{now 'iso'}}");
    case "date":
      return quote("{{now 'date'}}");
    case "time":
      return quote("{{now 'time'}}");
    case "uri":
    case "url":
      return quote("{{faker 'internet.url'}}");
    case "ipv4":
      return quote("{{faker 'internet.ipv4'}}");
    case "hostname":
      return quote("{{faker 'internet.domainName'}}");
  }
  if (/(^|_)id$|Id$/.test(name)) return quote("{{uuid}}");
  for (const [re, tpl] of BY_NAME) if (re.test(name)) return quote(tpl);
  return quote("{{faker 'lorem.word'}}");
}

function numberFor(schema: Schema, integer: boolean): string {
  const min = typeof schema["minimum"] === "number" ? schema["minimum"] : integer ? 1 : 0;
  const max = typeof schema["maximum"] === "number" ? schema["maximum"] : integer ? 1000 : 1000;
  return integer ? `{{int ${min} ${max}}}` : `{{float ${min} ${max} 2}}`;
}

/** First usable schema of a oneOf/anyOf/allOf, merged for allOf. */
function resolve(schema: Schema): Schema {
  if (Array.isArray(schema["allOf"])) {
    const merged: Schema = { type: "object", properties: {} };
    for (const part of schema["allOf"] as Schema[]) {
      const r = resolve(part);
      Object.assign(merged["properties"] as Schema, (r["properties"] as Schema) ?? {});
    }
    return merged;
  }
  for (const key of ["oneOf", "anyOf"]) {
    const list = schema[key];
    if (Array.isArray(list) && list.length) return resolve(list[0] as Schema);
  }
  return schema;
}

/**
 * Template text for a schema. `depth` stops runaway recursion in schemas that
 * refer to themselves (dereferenced cycles).
 */
export function templateFromSchema(input: unknown, name = "", depth = 0, indent = ""): string {
  if (!input || typeof input !== "object" || depth > 6) return "null";
  const schema = resolve(input as Schema);
  if ("example" in schema && schema["example"] !== undefined) return JSON.stringify(schema["example"]);
  if ("const" in schema) return JSON.stringify(schema["const"]);
  const type = Array.isArray(schema["type"]) ? (schema["type"] as string[]).find((t) => t !== "null") : (schema["type"] as string | undefined);
  const inner = `${indent}  `;
  if (type === "object" || (!type && schema["properties"])) {
    const props = Object.entries((schema["properties"] as Record<string, Schema>) ?? {});
    if (props.length === 0) return "{}";
    return `{\n${props.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${templateFromSchema(v, k, depth + 1, inner)}`).join(",\n")}\n${indent}}`;
  }
  if (type === "array") {
    const item = templateFromSchema(schema["items"], name.replace(/s$/, ""), depth + 1, inner);
    return `[\n${inner}{{#repeat 2}}\n${inner}${item}\n${inner}{{/repeat}}\n${indent}]`;
  }
  if (type === "integer") return numberFor(schema, true);
  if (type === "number") return numberFor(schema, false);
  if (type === "boolean") return "{{boolean}}";
  if (type === "string" || !type) return stringFor(schema, name);
  return "null";
}
