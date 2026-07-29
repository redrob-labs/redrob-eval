import { ProviderError } from '@redrob/harness';

export type GeneratedImage = {
  bytes: Buffer;
  ext: string;
  mime: string;
  latencyMs: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

async function bytesFromImageUrl(url: string): Promise<{ bytes: Buffer; ext: string; mime: string }> {
  if (url.startsWith('data:')) {
    const m = /^data:(image\/[\w+.-]+);base64,(.+)$/i.exec(url);
    if (!m) throw new ProviderError('Unrecognized data URL image', 'openrouter');
    const mime = m[1];
    return {
      mime,
      ext: mimeToExt(mime),
      bytes: Buffer.from(m[2], 'base64'),
    };
  }

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new ProviderError(`Failed to download image HTTP ${res.status}`, 'openrouter', res.status);
  }
  const mime = res.headers.get('content-type') || 'image/png';
  const ab = await res.arrayBuffer();
  return { bytes: Buffer.from(ab), mime, ext: mimeToExt(mime) };
}

type ChatImageMessage = {
  images?: { image_url?: { url?: string }; imageUrl?: { url?: string } }[];
  content?: string | { type?: string; image_url?: { url?: string } }[] | null;
};

function extractImageUrls(message: ChatImageMessage | undefined): string[] {
  if (!message) return [];
  const urls: string[] = [];
  for (const img of message.images ?? []) {
    const u = img.image_url?.url ?? img.imageUrl?.url;
    if (u) urls.push(u);
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === 'image_url' && part.image_url?.url) {
        urls.push(part.image_url.url);
      }
    }
  }
  return urls;
}

/**
 * Generate one image via OpenRouter chat completions + modalities.
 * Tries ["image","text"] then ["image"] for image-only models.
 */
export async function generateOpenRouterImage(params: {
  openrouterModelId: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
}): Promise<GeneratedImage> {
  const started = Date.now();
  const headers = openRouterHeaders();
  const url = `${baseUrl()}/chat/completions`;

  const modalityTries: string[][] = [
    ['image', 'text'],
    ['image'],
  ];

  let lastError: unknown;

  for (const modalities of modalityTries) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const body: Record<string, unknown> = {
          model: params.openrouterModelId,
          messages: [{ role: 'user', content: params.prompt }],
          modalities,
          stream: false,
        };
        if (params.aspectRatio || params.imageSize) {
          body.image_config = {
            ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
            ...(params.imageSize ? { image_size: params.imageSize } : {}),
          };
        }

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after') || 0);
          const backoff = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
          if (attempt < 3) {
            await sleep(backoff);
            continue;
          }
        }

        const json = (await res.json()) as {
          error?: { message?: string };
          choices?: { message?: ChatImageMessage }[];
        };

        if (!res.ok) {
          const msg = json.error?.message || `HTTP ${res.status}`;
          // modality mismatch → try next modalities set
          if (
            res.status === 400 &&
            /modalit/i.test(msg) &&
            modalities.length > 1
          ) {
            lastError = new ProviderError(msg, 'openrouter', res.status);
            break;
          }
          throw new ProviderError(msg, 'openrouter', res.status);
        }

        const urls = extractImageUrls(json.choices?.[0]?.message);
        if (!urls.length) {
          throw new ProviderError('No image in model response', 'openrouter');
        }

        const parsed = await bytesFromImageUrl(urls[0]);
        return {
          ...parsed,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        lastError = error;
        if (
          error instanceof ProviderError &&
          error.status &&
          error.status < 500 &&
          error.status !== 429
        ) {
          // non-retryable for this modality set — maybe try next modalities
          if (/modalit/i.test(error.message) && modalities.length > 1) break;
          throw error;
        }
        if (attempt < 3) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
      }
    }
  }

  if (lastError instanceof ProviderError) throw lastError;
  throw new ProviderError(
    lastError instanceof Error ? lastError.message : 'Image generation failed',
    'openrouter',
  );
}
