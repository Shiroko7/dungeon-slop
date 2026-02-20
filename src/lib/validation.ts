import type { ZodType, ZodError } from "zod";

export type SafeParseSuccess<T> = {
  success: true;
  data: T;
};

export type SafeParseFailure = {
  success: false;
  errors: string[];
};

export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseFailure;

export function safeParse<T>(
  schema: ZodType<T>,
  data: unknown,
): SafeParseResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: formatZodErrors(result.error),
  };
}

function formatZodErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}
