import { isLengthTruncation } from './usage';
import type { CellStatus, CompletionMatrix, Generation } from './types';

export function emptyMatrix(modelIds: string[], inputIds: string[]): CompletionMatrix {
  const cells: Record<string, Record<string, CellStatus>> = {};
  for (const m of modelIds) {
    cells[m] = {};
    for (const id of inputIds) cells[m]![id] = 'pending';
  }
  return {
    modelIds: [...modelIds],
    inputIds: [...inputIds],
    cells,
    completed: 0,
    total: modelIds.length * inputIds.length,
  };
}

export function cellStatusFromGeneration(g: Generation): CellStatus {
  if (g.error) return 'error';
  if (isLengthTruncation(g.finishReason)) return 'truncated';
  return 'ok';
}

export function markCell(
  matrix: CompletionMatrix,
  modelId: string,
  inputId: string,
  status: CellStatus,
): void {
  const row = matrix.cells[modelId];
  if (!row || !(inputId in row)) return;
  const prev = row[inputId];
  row[inputId] = status;
  if (prev === 'pending' && status !== 'pending') {
    matrix.completed += 1;
  }
}

export function matrixFromGenerations(
  modelIds: string[],
  inputIds: string[],
  generations: Generation[],
): CompletionMatrix {
  const matrix = emptyMatrix(modelIds, inputIds);
  for (const g of generations) {
    markCell(matrix, g.modelId, g.inputId, cellStatusFromGeneration(g));
  }
  return matrix;
}
