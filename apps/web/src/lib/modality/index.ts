import { imageModality } from './image';
import { textModality } from './text';
import type { ModalityAdapter, ModalityId } from './types';

export * from './types';

const ADAPTERS: Record<ModalityId, ModalityAdapter> = {
  text: textModality,
  image: imageModality,
};

export function getModality(id: string): ModalityAdapter | undefined {
  return ADAPTERS[id as ModalityId];
}

export function listModalities(): ModalityAdapter[] {
  return Object.values(ADAPTERS);
}
