'use client';

type Step = {
  n: number;
  title: string;
  detail: string;
  done?: boolean;
};

type Props = {
  canRun: boolean;
  configuredCount: number;
  providerTotal: number;
  hasSeed: boolean;
  runBlockedReason: string | null;
  onApplyStarter: () => void;
  onLoadSampleReport: () => void;
  onDismiss: () => void;
  sampleLoading?: boolean;
};

function evolveSteps(params: { canRun: boolean; hasSeed: boolean }): Step[] {
  const { canRun, hasSeed } = params;
  return [
    {
      n: 1,
      title: 'Provider key',
      detail: 'Set OPENROUTER_API_KEY in repo-root .env, restart yarn dev, then Refresh.',
      done: canRun,
    },
    {
      n: 2,
      title: 'Starter settings',
      detail: 'Apply cheap defaults: 5 samples, 6 rollouts, catalog dataset.',
      done: hasSeed,
    },
    {
      n: 3,
      title: 'Seed model',
      detail: 'Confirm Seed in Config (auto-picked from callable models).',
      done: hasSeed,
    },
    {
      n: 4,
      title: 'Run GEPA',
      detail: 'Click Run GEPA in the title bar. Frontier streams into Results.',
    },
  ];
}

export function GettingStartedPanel(props: Props) {
  const {
    canRun,
    configuredCount,
    providerTotal,
    hasSeed,
    runBlockedReason,
    onApplyStarter,
    onLoadSampleReport,
    onDismiss,
    sampleLoading,
  } = props;

  const steps = evolveSteps({ canRun, hasSeed });

  return (
    <div className="getting-started" role="region" aria-label="Getting started">
      <div className="getting-started-head">
        <div>
          <strong>Evolve guide</strong>
          <span className="getting-started-sub">
            {configuredCount}/{providerTotal} keys · steps for this module
          </span>
        </div>
        <button type="button" className="getting-started-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      {!canRun ? (
        <p className="getting-started-alert">
          Add a provider key to repo-root <code>.env</code> (recommended:{' '}
          <code>OPENROUTER_API_KEY</code>), restart <code>yarn dev</code>, then Refresh.
        </p>
      ) : runBlockedReason ? (
        <p className="getting-started-alert">{runBlockedReason}</p>
      ) : null}

      <ol className="getting-started-steps">
        {steps.map((s) => (
          <li key={s.n} data-done={s.done ? '1' : '0'}>
            <span className="getting-started-n">{s.done ? 'ok' : s.n}</span>
            <div>
              <strong>{s.title}</strong>
              <p>{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="getting-started-actions">
        <button type="button" className="getting-started-primary" onClick={onApplyStarter}>
          Apply starter settings
        </button>
        <button
          type="button"
          className="getting-started-secondary"
          disabled={sampleLoading}
          onClick={onLoadSampleReport}
        >
          {sampleLoading ? 'Loading…' : 'Preview sample report'}
        </button>
      </div>

      <p className="getting-started-foot">
        Offline sample needs no keys. Live runs call your provider. Methodology:{' '}
        <a
          href="https://github.com/redrob-labs/redrob-eval/blob/main/docs/methodology.md"
          target="_blank"
          rel="noreferrer"
        >
          docs/methodology.md
        </a>
        .
      </p>
    </div>
  );
}
