'use client';

import type { AppMode } from '@/lib/modules';

type SwitchTarget = AppMode | 'compare' | 'preference';

type Step = {
  n: number;
  title: string;
  detail: string;
  done?: boolean;
};

type Props = {
  mode: AppMode;
  canRun: boolean;
  openrouterReady: boolean;
  configuredCount: number;
  providerTotal: number;
  hasSmall: boolean;
  hasLarge: boolean;
  smallDiffersLarge: boolean;
  hasSeed: boolean;
  hasImageModels: boolean;
  runBlockedReason: string | null;
  onApplyStarter: () => void;
  onLoadSampleReport: () => void;
  onSwitchMode: (mode: SwitchTarget) => void;
  onDismiss: () => void;
  sampleLoading?: boolean;
};

function stepsForMode(params: {
  mode: AppMode;
  canRun: boolean;
  openrouterReady: boolean;
  hasSmall: boolean;
  hasLarge: boolean;
  smallDiffersLarge: boolean;
  hasSeed: boolean;
  hasImageModels: boolean;
}): Step[] {
  const {
    mode,
    canRun,
    openrouterReady,
    hasSmall,
    hasLarge,
    smallDiffersLarge,
    hasSeed,
    hasImageModels,
  } = params;

  if (mode === 'evolve') {
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

  if (mode === 'image') {
    return [
      {
        n: 1,
        title: 'OpenRouter key',
        detail: 'Image mode needs OPENROUTER_API_KEY specifically.',
        done: openrouterReady,
      },
      {
        n: 2,
        title: 'Pick generators',
        detail: 'Select ≥1 image model in the catalog pane.',
        done: hasImageModels,
      },
      {
        n: 3,
        title: 'Starter settings',
        detail: 'Apply defaults: 2 prompts, SFW suite, seed 42.',
        done: hasImageModels,
      },
      {
        n: 4,
        title: 'Run image',
        detail: 'Generate side-by-side, then pick a human preference winner.',
      },
    ];
  }

  return [
    {
      n: 1,
      title: 'Provider key',
      detail: 'Set a provider key in repo-root .env, restart yarn dev, then Refresh.',
      done: canRun,
    },
    {
      n: 2,
      title: 'Starter settings',
      detail: 'Apply cheap defaults: GSM8K, 5 samples, Small ≠ Large.',
      done: hasSmall && hasLarge,
    },
    {
      n: 3,
      title: 'Small + Large',
      detail: 'Dual-eval both models; oracle labels go to the routing corpus.',
      done: hasSmall && hasLarge && smallDiffersLarge,
    },
    {
      n: 4,
      title: 'Collect routing data',
      detail: 'Click Collect in the title bar. Scores and Pareto appear in Results.',
    },
  ];
}

export function GettingStartedPanel(props: Props) {
  const {
    mode,
    canRun,
    openrouterReady,
    configuredCount,
    providerTotal,
    hasSmall,
    hasLarge,
    smallDiffersLarge,
    hasSeed,
    hasImageModels,
    runBlockedReason,
    onApplyStarter,
    onLoadSampleReport,
    onSwitchMode,
    onDismiss,
    sampleLoading,
  } = props;

  const steps = stepsForMode({
    mode,
    canRun,
    openrouterReady,
    hasSmall,
    hasLarge,
    smallDiffersLarge,
    hasSeed,
    hasImageModels,
  });

  return (
    <div className="getting-started" role="region" aria-label="Getting started">
      <div className="getting-started-head">
        <div>
          <strong>First run</strong>
          <span className="getting-started-sub">
            Sample workflow · keys {configuredCount}/{providerTotal}
          </span>
        </div>
        <button type="button" className="getting-started-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      {!canRun ? (
        <p className="getting-started-alert">
          No provider keys detected. Copy <code>.env.example</code> → <code>.env</code>, set{' '}
          <code>OPENROUTER_API_KEY</code>, restart <code>yarn dev</code>, then Refresh.
        </p>
      ) : runBlockedReason ? (
        <p className="getting-started-alert">{runBlockedReason}</p>
      ) : null}

      <div className="getting-started-modes" role="group" aria-label="Choose a workflow">
        <button
          type="button"
          className={mode === 'evolve' ? 'on' : undefined}
          onClick={() => onSwitchMode('evolve')}
        >
          Evolve
          <span>recommended</span>
        </button>
        <button
          type="button"
          className={mode === 'text' ? 'on' : undefined}
          onClick={() => onSwitchMode('text')}
        >
          Text
          <span>routing labels</span>
        </button>
        <button
          type="button"
          className={mode === 'image' ? 'on' : undefined}
          onClick={() => onSwitchMode('image')}
        >
          Image
          <span>preference</span>
        </button>
        <button type="button" onClick={() => onSwitchMode('compare')}>
          Compare
          <span>multi-axis</span>
        </button>
        <button type="button" onClick={() => onSwitchMode('preference')}>
          Preference
          <span>task votes</span>
        </button>
      </div>

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
        {mode === 'evolve' ? (
          <button
            type="button"
            className="getting-started-secondary"
            disabled={sampleLoading}
            onClick={onLoadSampleReport}
          >
            {sampleLoading ? 'Loading…' : 'Preview sample report'}
          </button>
        ) : null}
      </div>

      <p className="getting-started-foot">
        Offline sample needs no keys. Live runs call your provider. Methodology:{' '}
        <a href="https://github.com/savagemanage/redrob-eval/blob/main/docs/methodology.md" target="_blank" rel="noreferrer">
          docs/methodology.md
        </a>
        .
      </p>
    </div>
  );
}
