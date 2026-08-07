/**
 * Parse a Hugging Face model reference from a pasted URL or `org/name` id.
 * Accepts:
 *   google/gemma-4-31B-it
 *   https://huggingface.co/google/gemma-4-31B-it
 *   https://huggingface.co/google/gemma-4-31B-it/tree/main
 *   https://hf.co/google/gemma-4-31B-it
 */
export function parseHfRepoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // Strip query/hash
  const cleaned = raw.split(/[?#]/)[0]!.replace(/\/+$/, '');

  // Full URL
  const urlMatch = cleaned.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/]+\/[^/]+)/i,
  );
  if (urlMatch) {
    return normalizeRepo(urlMatch[1]!);
  }

  // Bare org/name (optionally with /tree/... or /blob/...)
  const bare = cleaned.replace(/^(?:models\/)/i, '');
  const bareMatch = bare.match(/^([^/]+\/[^/]+)/);
  if (bareMatch) {
    return normalizeRepo(bareMatch[1]!);
  }

  return null;
}

function normalizeRepo(repo: string): string | null {
  const id = repo.trim();
  // HF repo ids: namespace/name — no spaces, reasonable charset
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    return null;
  }
  return id;
}

export function hfModelUrl(repoId: string): string {
  return `https://huggingface.co/${repoId}`;
}
