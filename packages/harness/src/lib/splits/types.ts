export type SplitName = 'train' | 'val' | 'test';

export interface SplitBundle<T> {
  train: T[];
  val: T[];
  test: T[];
}
