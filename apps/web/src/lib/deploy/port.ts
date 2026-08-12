export const DEFAULT_VLLM_PORT = 8000;

/** Resolve the public vLLM port, falling back safely when the setting is invalid. */
export function deployPort(): number {
  const raw = process.env.VLLM_PORT?.trim();
  if (!raw) return DEFAULT_VLLM_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : DEFAULT_VLLM_PORT;
}
