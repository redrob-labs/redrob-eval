'use client';

import { useT } from '@/components/LocaleProvider';

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

function evolveSteps(
  params: { canRun: boolean; hasSeed: boolean },
  t: ReturnType<typeof useT>,
): Step[] {
  const { canRun, hasSeed } = params;
  return [
    {
      n: 1,
      title: t('evolve.guide.step1.title'),
      detail: t('evolve.guide.step1.detail'),
      done: canRun,
    },
    {
      n: 2,
      title: t('evolve.guide.step2.title'),
      detail: t('evolve.guide.step2.detail'),
      done: hasSeed,
    },
    {
      n: 3,
      title: t('evolve.guide.step3.title'),
      detail: t('evolve.guide.step3.detail'),
      done: hasSeed,
    },
    {
      n: 4,
      title: t('evolve.guide.step4.title'),
      detail: t('evolve.guide.step4.detail'),
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

  const t = useT();
  const steps = evolveSteps({ canRun, hasSeed }, t);
  const footerParts = t('evolve.guide.footer').split('{link}');

  return (
    <div className="getting-started" role="region" aria-label={t('evolve.gettingStarted.aria')}>
      <div className="getting-started-head">
        <div>
          <strong>{t('evolve.guide.title')}</strong>
          <span className="getting-started-sub">
            {t('evolve.guide.stepsSub', { configured: configuredCount, total: providerTotal })}
          </span>
        </div>
        <button type="button" className="getting-started-dismiss" onClick={onDismiss}>
          {t('evolve.guide.dismiss')}
        </button>
      </div>

      {!canRun ? (
        <p className="getting-started-alert">{t('evolve.guide.noKeyAlert')}</p>
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
          {t('evolve.guide.applyStarter')}
        </button>
        <button
          type="button"
          className="getting-started-secondary"
          disabled={sampleLoading}
          onClick={onLoadSampleReport}
        >
          {sampleLoading ? t('evolve.guide.loadingSample') : t('evolve.guide.previewSample')}
        </button>
      </div>

      <p className="getting-started-foot">
        {footerParts[0]}
        <a
          href="https://github.com/redrob-labs/redrob-eval/blob/main/docs/methodology.md"
          target="_blank"
          rel="noreferrer"
        >
          {t('evolve.guide.methodologyLink')}
        </a>
        {footerParts[1]}
      </p>
    </div>
  );
}
