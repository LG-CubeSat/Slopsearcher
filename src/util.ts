export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function chunks(text: string, size = 1900): string[] {
  const result: string[] = [];
  for (let rest = text; rest.length;) {
    let end = rest.length <= size ? rest.length : rest.lastIndexOf("\n", size);
    if (end < size / 2) end = Math.min(size, rest.length);
    if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
    result.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, "");
  }
  return result.length ? result : ["(No response text.)"];
}
export const noMentions = { parse: [] as [], repliedUser: false };
export function parseJson(text: string): unknown {
  return JSON.parse(
    text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
  );
}

/** Bound optional context retrieval without delaying the question indefinitely. */
export async function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Context retrieval timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
