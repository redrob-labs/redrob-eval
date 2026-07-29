import type { MetricId } from '../../config/datasets';
import { accuracyMatch } from './accuracy';
import { checklistCompositeScore } from './checklist-composite';
import { chrf } from './chrf';
import { cohensKappaFromPair } from './cohens-kappa';
import { gsm8kExactMatch } from './gsm8k';
import { qwkFromPairs, qwkPairProxy } from './qwk';
import { abstentionPairFeedback } from './abstention';

export interface MetricFixture {
  id: string;
  metric: MetricId;
  gold: string;
  prediction: string;
  /** Multi-pair golds for batch QWK fixtures */
  golds?: string[];
  predictions?: string[];
  /** Expected score; for chrf use approximate band via minScore/maxScore */
  expectScore?: number;
  minScore?: number;
  maxScore?: number;
  note: string;
}

export const METRIC_FIXTURES: MetricFixture[] = [
  {
    id: 'chrf-identical',
    metric: 'chrf',
    gold: 'सेवा संबंधी लोगों के लिए भेष कई गुणों का संयोजन है।',
    prediction: 'सेवा संबंधी लोगों के लिए भेष कई गुणों का संयोजन है।',
    expectScore: 1,
    note: 'Identical strings → chrF = 1',
  },
  {
    id: 'chrf-empty-vs-text',
    metric: 'chrf',
    gold: 'hello world',
    prediction: '',
    expectScore: 0,
    note: 'Empty hypothesis → chrF = 0',
  },
  {
    id: 'chrf-close',
    metric: 'chrf',
    gold: 'The appearance is a combination of attributes.',
    prediction: 'The appearance is a combination of attribute.',
    minScore: 0.7,
    maxScore: 1,
    note: 'Near-match English should score high chrF',
  },
  {
    id: 'chrf-unrelated',
    metric: 'chrf',
    gold: 'The appearance is a combination of attributes.',
    prediction: 'zzzz qqqq xxxx',
    maxScore: 0.15,
    note: 'Unrelated text should score near zero',
  },
  {
    id: 'acc-exact',
    metric: 'accuracy',
    gold: '2',
    prediction: '2',
    expectScore: 1,
    note: 'Exact label match',
  },
  {
    id: 'acc-from-sentence',
    metric: 'accuracy',
    gold: '1',
    prediction: 'The sentiment label is 1',
    expectScore: 1,
    note: 'Extract numeric label from verbose prediction',
  },
  {
    id: 'acc-mismatch',
    metric: 'accuracy',
    gold: '0',
    prediction: '2',
    expectScore: 0,
    note: 'Wrong label → 0',
  },
  {
    id: 'gsm8k-hash',
    metric: 'gsm8k_exact',
    gold: 'She makes 9 * 2 = $<<9*2=18>>18 every day.\n#### 18',
    prediction: 'The ducks yield $18.\n#### 18',
    expectScore: 1,
    note: '#### answer extraction matches',
  },
  {
    id: 'gsm8k-phrase',
    metric: 'gsm8k_exact',
    gold: '#### 540',
    prediction: 'He runs 540 meters. The answer is 540',
    expectScore: 1,
    note: '"The answer is N" extraction',
  },
  {
    id: 'gsm8k-comma',
    metric: 'gsm8k_exact',
    gold: '#### 70000',
    prediction: 'Profit is $70,000',
    expectScore: 1,
    note: 'Comma / currency normalization',
  },
  {
    id: 'gsm8k-wrong',
    metric: 'gsm8k_exact',
    gold: '#### 18',
    prediction: '#### 19',
    expectScore: 0,
    note: 'Wrong numeric answer → 0',
  },
  {
    id: 'qwk-perfect',
    metric: 'qwk',
    gold: '0',
    prediction: '0',
    golds: ['0', '1', '2', '3', '4'],
    predictions: ['0', '1', '2', '3', '4'],
    expectScore: 1,
    note: 'Identical ordinals → QWK = 1',
  },
  {
    id: 'qwk-disagree',
    metric: 'qwk',
    gold: '0',
    prediction: '4',
    golds: ['0', '0', '0', '0'],
    predictions: ['4', '4', '4', '4'],
    maxScore: 0.05,
    note: 'Systematic extreme disagreement → near-zero / negative QWK clipped',
  },
  {
    id: 'qwk-abstain-excluded',
    metric: 'qwk',
    gold: '2',
    prediction: 'ABSTAIN',
    golds: ['0', '1', '2', '3'],
    predictions: ['0', '1', 'ABSTAIN', '3'],
    expectScore: 1,
    note: 'Abstentions excluded from QWK; remaining exact matches → 1',
  },
  {
    id: 'kappa-items',
    metric: 'cohens_kappa',
    gold: '{"items":[1,0,1,1]}',
    prediction: '{"items":[1,0,1,1]}',
    expectScore: 1,
    note: 'Identical binary checklist → κ = 1',
  },
  {
    id: 'checklist-composite-match',
    metric: 'checklist_composite',
    gold: '{"items":[1,1,0],"total":2,"weights":[1,1,1]}',
    prediction: '{"items":[1,1,0]}',
    expectScore: 1,
    note: 'Weighted sum matches human total',
  },
  {
    id: 'abstention-yes',
    metric: 'abstention_rate',
    gold: '2',
    prediction: 'ABSTAIN',
    expectScore: 1,
    note: 'Single abstention → rate 1',
  },
];

export interface FixtureRunResult {
  id: string;
  metric: MetricId;
  pass: boolean;
  score: number;
  expected?: string;
  note: string;
}

function scoreFixture(f: MetricFixture): number {
  switch (f.metric) {
    case 'chrf':
      return chrf(f.prediction, f.gold).score;
    case 'accuracy':
      return accuracyMatch(f.gold, f.prediction).score;
    case 'gsm8k_exact':
      return gsm8kExactMatch(f.gold, f.prediction).score;
    case 'qwk':
      if (f.golds && f.predictions) {
        return qwkFromPairs(f.golds, f.predictions).score;
      }
      return qwkPairProxy(f.gold, f.prediction).score;
    case 'cohens_kappa':
      return cohensKappaFromPair(f.gold, f.prediction).score;
    case 'checklist_composite':
      return checklistCompositeScore(f.gold, f.prediction).score;
    case 'abstention_rate':
      return abstentionPairFeedback(f.prediction).score;
    case 'llm_judge':
      throw new Error('llm_judge fixtures are not supported in offline metric fixtures');
    default: {
      const _exhaustive: never = f.metric;
      throw new Error(`Unknown metric: ${_exhaustive}`);
    }
  }
}

export function runMetricFixtures(): FixtureRunResult[] {
  return METRIC_FIXTURES.map((f) => {
    const score = scoreFixture(f);
    let pass = true;
    const expectedParts: string[] = [];

    if (f.expectScore != null) {
      pass = pass && Math.abs(score - f.expectScore) < 1e-9;
      expectedParts.push(`== ${f.expectScore}`);
    }
    if (f.minScore != null) {
      pass = pass && score >= f.minScore;
      expectedParts.push(`>= ${f.minScore}`);
    }
    if (f.maxScore != null) {
      pass = pass && score <= f.maxScore;
      expectedParts.push(`<= ${f.maxScore}`);
    }

    return {
      id: f.id,
      metric: f.metric,
      pass,
      score,
      expected: expectedParts.join(' && ') || undefined,
      note: f.note,
    };
  });
}
