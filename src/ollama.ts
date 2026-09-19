// What Ollama's refusals MEAN — one reading, shared by both jobs that talk to it.
//
// Pure: a status and a body in, a verdict out. It exists as its own module because two callers
// need exactly this answer (the category suggester in llm.ts, the invoice reader in
// receipt-llm.ts), and two copies of "what does a 500 from Ollama mean" is how one of them comes
// to say "the model answered 500" while the other says "lower the window".

import type { LlmProfile } from "./llm-config.ts";

export type OllamaDiagnosis = {
  /**
   * A SETTING is wrong for this machine, and retrying cannot help: every attempt fails the same
   * way, and each one reloads the model first — 65s on the machine this was built on.
   */
  misconfigured: boolean;
  /** For a person. Names the one variable to change whenever there is one. */
  message: string;
};

/**
 * Read an Ollama error response.
 *
 * Three refusals are settings problems, and they are exactly the three a person running this on
 * their own machine meets first: a model they have not pulled, a window their memory cannot
 * hold, and a thinking flag their model does not accept. Everything else is reported with
 * Ollama's own words attached — a bare status code is a reason nobody can act on.
 *
 * Tested against the exact message Ollama sent on the machine this was built on when the
 * window was too large for its memory.
 */
export function diagnoseOllamaRefusal(
  status: number,
  body: string,
  p: Pick<LlmProfile, "prefix" | "model" | "numCtx">,
): OllamaDiagnosis {
  if (status === 404 || /model ['"]?[^'"]*['"]? not found/i.test(body)) {
    return {
      misconfigured: true,
      message:
        `the model "${p.model}" is not available in Ollama — run \`ollama pull ${p.model}\`, ` +
        `or set ${p.prefix}_MODEL to a model you have`,
    };
  }
  if (/out[- ]of[- ]memory|requires more system memory|failed to allocate|insufficient memory/i.test(body)) {
    const window = p.numCtx === null ? "Ollama's default window" : `a ${p.numCtx}-token window`;
    return {
      misconfigured: true,
      message:
        `"${p.model}" does not fit in memory with ${window} — set ${p.prefix}_NUM_CTX lower, ` +
        `or set ${p.prefix}_MODEL to a smaller model`,
    };
  }
  if (/does not support thinking/i.test(body)) {
    return {
      misconfigured: true,
      message: `"${p.model}" does not accept a thinking setting — set ${p.prefix}_THINK=unset`,
    };
  }
  return {
    misconfigured: false,
    message: `the local model answered ${status}${body ? `: ${body}` : ""}`,
  };
}
