'use client';

import { delta, rankEntries, type ArenaEntry } from './model-arena';

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function signed(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;
}

/**
 * Which model to ship the evolved prompt on.
 *
 * Ranked by held-out test rather than by improvement: improvement ranks by how bad the
 * model started, and the model that gains most is routinely not the one to ship. The
 * evolved prompt sits under each row because the answer is a pair — this model, with
 * this prompt — and showing the model alone invites someone to take the name and leave
 * the reason behind.
 */
export function ModelArena({ entries }: { entries: ArenaEntry[] }) {
  if (entries.length === 0) return null;

  const ranked = rankEntries(entries);
  const dimensionNames = [...new Set(ranked.flatMap((e) => Object.keys(e.dimensions ?? {})))];
  const finished = ranked.filter((e) => e.status === 'done').length;

  return (
    <section className="arena">
      <div className="arena-head">
        <div className="pane-label">Which model to ship the prompt on</div>
        <span className="field-hint">
          {finished}/{entries.length} finished · ranked by held-out test, not by the split
          each run was fitted to, and not by how much it improved
        </span>
      </div>

      <div className="table-scroll">
        <table className="data-table text-xs">
          <thead>
            <tr>
              <th>#</th>
              <th>Model</th>
              <th>Baseline</th>
              <th>Evolved</th>
              <th>Δ pts</th>
              <th>Test</th>
              <th>Tokens</th>
              {dimensionNames.map((d) => (
                <th key={d} title={`${d}, out of 10, for the evolved prompt`}>
                  {d.slice(0, 9)}
                </th>
              ))}
              <th>Progress</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((e, i) => {
              const d = delta(e);
              return (
                <tr key={e.modelId}>
                  <td>{e.status === 'done' ? i + 1 : '·'}</td>
                  <td>
                    <strong>{e.label}</strong>
                    <div className="arena-sub">
                      <code>{e.modelId}</code>
                      {e.error ? <span className="arena-error"> · {e.error}</span> : null}
                    </div>
                  </td>
                  <td>{pct(e.baselineQuality)}</td>
                  <td>{pct(e.evolvedQuality)}</td>
                  <td
                    className={d == null || d === 0 ? undefined : d > 0 ? 'delta-up' : 'delta-down'}
                  >
                    {signed(d)}
                  </td>
                  <td>{pct(e.testQuality)}</td>
                  <td>
                    {e.evolvedTokens ?? '—'}
                    {e.baselineTokens != null && e.evolvedTokens != null ? (
                      <span className="arena-sub">
                        {' '}
                        ({e.evolvedTokens - e.baselineTokens >= 0 ? '+' : ''}
                        {e.evolvedTokens - e.baselineTokens})
                      </span>
                    ) : null}
                  </td>
                  {dimensionNames.map((name) => (
                    <td key={name}>
                      {e.dimensions?.[name] == null ? '—' : (e.dimensions[name] * 10).toFixed(1)}
                    </td>
                  ))}
                  <td>
                    <span className={`arena-status is-${e.status}`}>{e.status}</span>
                    {e.status === 'running' ? ` ${e.rollouts}/${e.maxRollouts}` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {ranked
        .filter((e) => e.instruction)
        .map((e) => (
          <details key={e.modelId} className="arena-prompt">
            <summary>
              Evolved prompt for <strong>{e.label}</strong>
            </summary>
            <pre>{e.instruction}</pre>
          </details>
        ))}
    </section>
  );
}
