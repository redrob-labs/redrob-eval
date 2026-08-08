// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge letting the Python study runner reach models through the harness.
 *
 * Reads one JSON request on stdin and writes one JSON response on stdout:
 *
 *     {"model_id": "openai/gpt-4o-mini", "prompt": "..."}
 *     -> {"text": "...", "provider_id": "openai", "model_id": "gpt-4o-mini", ...}
 *
 * The point of this file is that it is thin. Everything it does -- resolving a
 * canonical model id, choosing a provider adapter, retrying, reading keys from the
 * environment -- is `callModel` and `resolveModel` doing it, the same way the Compare
 * module does. A study must not acquire its own opinion about how to talk to a
 * provider, because then there would be two opinions and the numbers would depend on
 * which one produced them.
 *
 * Deliberately not wired into any route: it reads credentials from the environment and
 * writes to stdout, which is a command line contract, not an HTTP one.
 */
import { callModel } from "../packages/harness/src/lib/providers/index";
import { resolveModel } from "../packages/harness/src/lib/catalog/resolve";

interface Request {
  model_id: string;
  prompt: string;
  system_prompt?: string;
  max_tokens?: number | null;
  temperature?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let request: Request;
  try {
    request = JSON.parse(raw) as Request;
  } catch (err) {
    fail(`request is not JSON: ${(err as Error).message}`);
  }
  if (
    typeof request.model_id !== "string" ||
    typeof request.prompt !== "string"
  ) {
    fail("request needs a string model_id and a string prompt");
  }

  const resolved = await resolveModel(request.model_id);
  if (!resolved) {
    fail(
      `unknown model id ${request.model_id}; it is not in the curated catalog or OpenRouter`,
    );
  }

  const result = await callModel(
    resolved.providerId,
    resolved.modelId,
    request.prompt,
    {
      systemPrompt: request.system_prompt,
      maxTokens: request.max_tokens ?? null,
      // Zero rather than a default, because a study rerun that produced different text
      // would break the reproducibility guarantee the artifact claims. It does not make
      // a provider deterministic, and the artifact does not pretend that it does.
      temperature: request.temperature ?? 0,
    },
  );

  process.stdout.write(
    `${JSON.stringify({
      text: result.text,
      provider_id: result.providerId,
      model_id: result.modelId,
      input_tokens: result.inputTokens ?? null,
      output_tokens: result.outputTokens ?? null,
      finish_reason: result.finishReason ?? null,
    })}\n`,
  );
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
