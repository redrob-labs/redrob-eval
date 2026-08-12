import { promises as fs } from 'node:fs';
import { ProviderError } from '@redrob/harness';
import { resolveRunFile } from './fs';

function openRouterHeaders(): Record<string, string> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new ProviderError('OPENROUTER_API_KEY is not set', 'openrouter');
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:3939',
    'X-Title': 'redrob-eval',
  };
}

function baseUrl(): string {
  return (
    process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1'
  ).replace(/\/$/, '');
}

function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  return 'image/png';
}

async function fileToDataUrl(absPath: string): Promise<string> {
  const bytes = await fs.readFile(absPath);
  const ext = absPath.split('.').pop() || 'png';
  return `data:${mimeFromExt(ext)};base64,${bytes.toString('base64')}`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  const body = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error('Judge did not return JSON');
  }
}

type AutoJudgeCandidate = {
  modelId: string;
  relativePath: string;
};

export type AutoJudgeResult = {
  winner: string;
  rationale: string;
  scores: {
    modelId: string;
    promptAdherence: number;
    overall: number;
    notes?: string;
  }[];
};

/**
 * Vision LLM-as-judge: prompt adherence + N-way preference.
 * Uses OpenRouter multimodal chat (e.g. openai/gpt-4o, google/gemini-*).
 */
export async function judgePreference(params: {
  judgeOpenrouterId: string;
  prompt: string;
  candidates: AutoJudgeCandidate[];
  runId: string;
}): Promise<AutoJudgeResult> {
  if (params.candidates.length === 0) {
    throw new Error('No images to judge');
  }

  const content: (
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  )[] = [];

  const labels = params.candidates.map((c, i) => `Image ${String.fromCharCode(65 + i)}`);
  const idByLabel = Object.fromEntries(
    params.candidates.map((c, i) => [labels[i], c.modelId]),
  );

  content.push({
    type: 'text',
    text: [
      'You are an impartial image quality judge for a text-to-image bake-off.',
      'Score each image for prompt adherence and overall quality (composition, artifacts, anatomy, photorealism).',
      'Then pick a single winner label, or "tie" if they are essentially equal.',
      '',
      `Prompt:\n${params.prompt}`,
      '',
      'Images:',
      ...params.candidates.map((c, i) => `${labels[i]} = model ${c.modelId}`),
      '',
      'Respond with ONLY valid JSON matching:',
      JSON.stringify(
        {
          scores: [
            {
              label: 'Image A',
              promptAdherence: 0,
              overall: 0,
              notes: 'short',
            },
          ],
          winner: 'Image A or tie',
          rationale: 'one sentence',
        },
        null,
        2,
      ),
      'Scores are integers 1-10.',
    ].join('\n'),
  });

  for (let i = 0; i < params.candidates.length; i++) {
    const c = params.candidates[i];
    const abs = resolveRunFile(params.runId, c.relativePath);
    const dataUrl = await fileToDataUrl(abs);
    content.push({ type: 'text', text: `${labels[i]}:` });
    content.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: params.judgeOpenrouterId,
      temperature: 0,
      max_tokens: 800,
      messages: [{ role: 'user', content }],
    }),
  });

  const json = (await res.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string | null } }[];
  };

  if (!res.ok) {
    throw new ProviderError(
      json.error?.message || `Judge HTTP ${res.status}`,
      'openrouter',
      res.status,
    );
  }

  const text = json.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new ProviderError('Empty judge response', 'openrouter');

  const parsed = extractJson(text) as {
    scores?: {
      label?: string;
      modelId?: string;
      promptAdherence?: number;
      overall?: number;
      notes?: string;
    }[];
    winner?: string;
    rationale?: string;
  };

  const scores = (parsed.scores ?? []).map((s, i) => {
    const label = s.label ?? labels[i];
    const modelId = s.modelId ?? idByLabel[label] ?? params.candidates[i]?.modelId;
    return {
      modelId,
      promptAdherence: Number(s.promptAdherence) || 0,
      overall: Number(s.overall) || 0,
      notes: s.notes,
    };
  });

  let winner = 'tie';
  const w = String(parsed.winner ?? 'tie').trim();
  if (/^tie$/i.test(w)) {
    winner = 'tie';
  } else if (idByLabel[w]) {
    winner = idByLabel[w];
  } else if (params.candidates.some((c) => c.modelId === w)) {
    winner = w;
  } else {
    // fallback: highest overall
    const best = [...scores].sort((a, b) => b.overall - a.overall)[0];
    winner = best?.modelId ?? 'tie';
  }

  return {
    winner,
    rationale: parsed.rationale ?? '',
    scores,
  };
}
