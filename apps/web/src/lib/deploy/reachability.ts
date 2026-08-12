/**
 * Why an active slot did not answer this machine.
 *
 * The distinction matters because the remedies are opposite. A refused
 * connection means the port is open and nothing is behind it yet: vLLM is
 * still loading, or it died. A dropped one means the connection never gets
 * there at all. Reporting both as "open the firewall port" sent people after a
 * rule that was already in place, once per restart.
 */
export type SlotReachKind = 'ok' | 'refused' | 'blocked' | 'wrongModel' | 'unknown';

export function classifyReachFailure(error: string | null): SlotReachKind {
  if (!error) return 'unknown';
  if (/ECONNREFUSED|ECONNRESET|connection refused/i.test(error)) return 'refused';
  // A dropped packet surfaces as a timeout and an unroutable host as one of
  // these codes; either way nothing on the path let the connection through.
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|No response from/i.test(error)) return 'blocked';
  return 'unknown';
}
