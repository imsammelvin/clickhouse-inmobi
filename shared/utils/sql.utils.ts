/**
 * Parsing helpers for the canonical DDL file.
 */

/** First few words of a statement, for progress output. */
export const statementLabel = (statement: string): string =>
  statement.replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ");

const stripComments = (statement: string): string =>
  statement
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();

/**
 * Split a SQL file into statements. A naive `split(";")` would break on a `;` inside a comment or
 * a quoted string, so track both states while scanning.
 */
export const splitStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let buffer = "";
  let inLineComment = false;
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      buffer += char;
    } else if (quote) {
      if (char === "\\") {
        buffer += char + (next ?? "");
        i++;
      } else {
        if (char === quote) quote = null;
        buffer += char;
      }
    } else if (char === "-" && next === "-") {
      inLineComment = true;
      buffer += char;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      buffer += char;
    } else if (char === ";") {
      statements.push(buffer);
      buffer = "";
    } else {
      buffer += char;
    }
  }
  statements.push(buffer);

  return statements.map(stripComments).filter((statement) => statement.length > 0);
};
