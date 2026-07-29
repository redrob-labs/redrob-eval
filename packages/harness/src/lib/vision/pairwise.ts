/**
 * Shared pairwise / relative vision judging primitives.
 * Image mode (apps/web) and checklist/video scoring share these content builders
 * so preference bake-offs and anchor comparisons stay consistent.
 */

import type { VisionImagePart } from '../providers/types';

export interface VisionContentText {
  type: 'text';
  text: string;
}

export interface VisionContentImage {
  type: 'image_url';
  image_url: { url: string };
}

export type VisionContentPart = VisionContentText | VisionContentImage;

export function imagePartToContent(img: VisionImagePart): VisionContentImage {
  return {
    type: 'image_url',
    image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
  };
}

/**
 * Pack a prompt + N labeled image groups (e.g. candidate A/B or beginner/skilled anchors).
 * Same shape the side-by-side image judge uses.
 */
export function buildPairwiseVisionContent(params: {
  preamble: string;
  groups: Array<{ label: string; images: VisionImagePart[] }>;
  closing: string;
}): VisionContentPart[] {
  const content: VisionContentPart[] = [{ type: 'text', text: params.preamble }];
  for (const g of params.groups) {
    content.push({ type: 'text', text: `\n### ${g.label}` });
    for (const img of g.images) {
      content.push(imagePartToContent(img));
    }
  }
  content.push({ type: 'text', text: params.closing });
  return content;
}

/** Flatten multimodal content to a text prompt + image list for callModel. */
export function splitVisionContent(parts: VisionContentPart[]): {
  prompt: string;
  images: VisionImagePart[];
} {
  const textBits: string[] = [];
  const images: VisionImagePart[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      textBits.push(p.text);
    } else {
      const url = p.image_url.url;
      const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
      if (m) {
        images.push({ mimeType: m[1]!, base64: m[2]! });
      }
    }
  }
  return { prompt: textBits.join('\n'), images };
}
