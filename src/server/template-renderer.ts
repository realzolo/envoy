import Handlebars from "handlebars";

type VariableType = "string" | "number" | "boolean";

export function validateTemplateVariables(
  schema: Record<string, VariableType>,
  variables: Record<string, unknown>,
) {
  const errors: string[] = [];
  for (const [name, expectedType] of Object.entries(schema)) {
    const value = variables[name];
    if (value === undefined || value === null || value === "") {
      errors.push(`Missing template variable: ${name}`);
      continue;
    }
    if (typeof value !== expectedType) {
      errors.push(`Template variable ${name} must be ${expectedType}`);
    }
  }
  return errors;
}

export function renderTemplate(
  template: { subjectTemplate: string; htmlTemplate: string; textTemplate: string },
  variables: Record<string, unknown>,
) {
  const options = { strict: true } as const;
  return {
    subject: Handlebars.compile(template.subjectTemplate, options)(variables),
    html: Handlebars.compile(template.htmlTemplate, options)(variables),
    text: Handlebars.compile(template.textTemplate, options)(variables),
  };
}
