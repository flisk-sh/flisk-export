/** A refusal the CLI prints as "Error: <message>" followed by one "-> <hint>" line per hint, then exits 1. */
export class ExportError extends Error {
  readonly hints: readonly string[];

  constructor(message: string, hints: readonly string[] = []) {
    super(message);
    this.name = "ExportError";
    this.hints = hints;
  }
}
