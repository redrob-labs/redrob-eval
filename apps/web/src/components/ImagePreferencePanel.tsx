'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

type Rating = {
  suite: string;
  prompt_id: string;
  models: string[];
  winner: string;
  notes: string;
  source?: 'human' | 'auto' | 'mixed';
  auto?: {
    winner: string;
    rationale?: string;
    scores?: {
      modelId: string;
      promptAdherence: number;
      overall: number;
      notes?: string;
    }[];
  };
};

type Prompt = {
  id: string;
  prompt: string;
  tags?: string[];
};

type Meta = {
  runId: string;
  suiteId: string;
  modelIds: string[];
  modelLabels: Record<string, string>;
  promptIds: string[];
  status: string;
  autoJudge?: boolean;
  judgeModelId?: string;
  error?: string;
};

type Artifact = {
  modelId: string;
  promptId: string;
  relativePath: string;
  error?: string;
  latencyMs?: number;
};

function fileUrl(runId: string, relativePath: string) {
  return `/api/image/runs/${encodeURIComponent(runId)}?file=${encodeURIComponent(relativePath)}`;
}

export function ImagePreferencePanel(props: {
  runId: string | null;
  onNeedRefresh?: () => void;
}) {
  const { runId } = props;
  const [meta, setMeta] = useState<Meta | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [ratings, setRatings] = useState<Rating[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);
  const [promptFilter, setPromptFilter] = useState('all');

  const load = useCallback(async (id: string) => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/image/runs/${encodeURIComponent(id)}`);
      const data = (await res.json()) as {
        error?: string;
        meta?: Meta;
        suite?: { prompts?: Prompt[] };
        ratings?: Rating[];
        artifacts?: Artifact[];
      };
      if (!res.ok) throw new Error(data.error || 'Failed to load run');
      setMeta(data.meta ?? null);
      setPrompts(data.suite?.prompts ?? []);
      setRatings(data.ratings ?? []);
      setArtifacts(data.artifacts ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    if (!runId) {
      setMeta(null);
      setPrompts([]);
      setRatings([]);
      setArtifacts([]);
      return;
    }
    void load(runId);
  }, [runId, load]);

  const visiblePrompts = useMemo(() => {
    const ids = new Set(meta?.promptIds ?? prompts.map((p) => p.id));
    return prompts.filter((p) => ids.has(p.id));
  }, [prompts, meta]);

  const filtered = useMemo(() => {
    if (promptFilter === 'all') return visiblePrompts;
    return visiblePrompts.filter((p) => p.id === promptFilter);
  }, [visiblePrompts, promptFilter]);

  const setWinner = (promptId: string, winner: string) => {
    setRatings((prev) =>
      prev.map((row) =>
        row.prompt_id === promptId
          ? {
              ...row,
              winner,
              source: row.source === 'auto' ? 'mixed' : row.source ?? 'human',
            }
          : row,
      ),
    );
  };

  const setNotes = (promptId: string, notes: string) => {
    setRatings((prev) =>
      prev.map((row) => (row.prompt_id === promptId ? { ...row, notes } : row)),
    );
  };

  const save = async () => {
    if (!runId) return;
    setSaving(true);
    setSaveNote(null);
    try {
      const res = await fetch(`/api/image/runs/${encodeURIComponent(runId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratings }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSaveNote('Saved');
    } catch (e) {
      setSaveNote(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const runJudge = async () => {
    if (!runId) return;
    setJudging(true);
    setSaveNote(null);
    try {
      const res = await fetch(
        `/api/image/runs/${encodeURIComponent(runId)}/judge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            judgeModelId: meta?.judgeModelId || 'or/openai/gpt-4o',
            overwriteHuman: false,
          }),
        },
      );
      const data = (await res.json()) as {
        error?: string;
        ratings?: Rating[];
        meta?: Meta;
      };
      if (!res.ok) throw new Error(data.error || 'Judge failed');
      if (data.ratings) setRatings(data.ratings);
      if (data.meta) setMeta(data.meta);
      setSaveNote('Auto-judge applied (empty winners only)');
    } catch (e) {
      setSaveNote(e instanceof Error ? e.message : 'Judge failed');
    } finally {
      setJudging(false);
    }
  };

  const winTally = useMemo(() => {
    const ids = meta?.modelIds ?? [];
    const map = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const row of ratings) {
      if (row.winner && row.winner !== 'tie' && map[row.winner] != null) {
        map[row.winner] += 1;
      }
    }
    return map;
  }, [ratings, meta]);

  const ratedCount = ratings.filter((r) => r.winner).length;

  if (!runId) {
    return (
      <p className="empty">
        Select image models → run preference. Side-by-side ratings land here.
        Open Guide for a sample workflow if this is your first run.
      </p>
    );
  }

  if (loadError) return <p className="eval-error">{loadError}</p>;
  if (!meta) return <p className="empty">Loading run…</p>;

  return (
    <div className="img-pref">
      <div className="img-pref-toolbar">
        <div>
          <div className="pane-label">Run {meta.runId}</div>
          <p className="field-hint">
            {ratedCount}/{ratings.length} rated
            {meta.autoJudge ? ` · auto ${meta.judgeModelId ?? ''}` : ''}
            {meta.error ? ` · ${meta.error}` : ''}
          </p>
        </div>
        <div className="img-pref-actions">
          <select
            value={promptFilter}
            onChange={(e) => setPromptFilter(e.target.value)}
            aria-label="Filter prompt"
          >
            <option value="all">All prompts</option>
            {visiblePrompts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="app-ghost-btn"
            disabled={judging}
            onClick={() => void runJudge()}
          >
            {judging ? 'Judging…' : 'Auto-judge'}
          </button>
          <button
            type="button"
            className="app-run-btn"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save ratings'}
          </button>
        </div>
      </div>

      {saveNote ? <p className="field-hint">{saveNote}</p> : null}

      <div className="img-pref-tally">
        {(meta.modelIds ?? []).map((id) => (
          <span key={id}>
            {meta.modelLabels[id] ?? id}: <strong>{winTally[id] ?? 0}</strong>
          </span>
        ))}
      </div>

      <div className="img-pref-list">
        {filtered.map((prompt) => {
          const rating = ratings.find((r) => r.prompt_id === prompt.id);
          const arts = artifacts.filter((a) => a.promptId === prompt.id);
          return (
            <article key={prompt.id} className="img-pref-card">
              <header>
                <strong>{prompt.id}</strong>
                {prompt.tags?.length ? (
                  <span className="sub">{prompt.tags.join(' · ')}</span>
                ) : null}
              </header>
              <details>
                <summary>Prompt</summary>
                <p>{prompt.prompt}</p>
              </details>

              <div
                className="img-pref-grid"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(arts.length, 1)}, minmax(0, 1fr))`,
                }}
              >
                {arts.map((a) => {
                  const isWinner = rating?.winner === a.modelId;
                  return (
                    <button
                      key={`${a.modelId}-${a.relativePath}`}
                      type="button"
                      className={cn('img-pref-thumb', isWinner && 'winner')}
                      onClick={() => setWinner(prompt.id, a.modelId)}
                      disabled={!a.relativePath}
                      title={a.error || 'Mark winner'}
                    >
                      <span className="img-pref-model">
                        {meta.modelLabels[a.modelId] ?? a.modelId}
                      </span>
                      {a.relativePath ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={fileUrl(meta.runId, a.relativePath)}
                          alt={a.modelId}
                          loading="lazy"
                        />
                      ) : (
                        <span className="img-pref-err">{a.error || 'failed'}</span>
                      )}
                      {a.latencyMs != null ? (
                        <span className="sub">{Math.round(a.latencyMs)} ms</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <div className="img-pref-rate">
                <label>
                  Winner
                  <select
                    value={rating?.winner ?? ''}
                    onChange={(e) => setWinner(prompt.id, e.target.value)}
                  >
                    <option value="">—</option>
                    {(meta.modelIds ?? []).map((id) => (
                      <option key={id} value={id}>
                        {meta.modelLabels[id] ?? id}
                      </option>
                    ))}
                    <option value="tie">Tie</option>
                  </select>
                </label>
                <label className="grow">
                  Notes
                  <input
                    type="text"
                    value={rating?.notes ?? ''}
                    onChange={(e) => setNotes(prompt.id, e.target.value)}
                    placeholder="optional"
                  />
                </label>
                {rating?.source ? (
                  <span className="sub">{rating.source}</span>
                ) : null}
              </div>

              {rating?.auto?.scores?.length ? (
                <div className="img-pref-auto">
                  <span className="sub">
                    Auto → {rating.auto.winner}
                    {rating.auto.rationale ? ` · ${rating.auto.rationale}` : ''}
                  </span>
                  <ul>
                    {rating.auto.scores.map((s) => (
                      <li key={s.modelId}>
                        {meta.modelLabels[s.modelId] ?? s.modelId}: adhere{' '}
                        {s.promptAdherence}/10 · overall {s.overall}/10
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
