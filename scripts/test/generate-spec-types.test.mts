// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The generated types must still match the schema they came from.
 * Run: yarn test
 *
 * `spec-types.generated.ts` is checked in so that the harness typechecks without a build
 * step, which means it can go stale the moment someone edits the schema. This is the
 * check that turns that into a test failure instead of a confusing type error later.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

test('spec-types.generated.ts is up to date with the JSON schema', () => {
  const script = path.join(process.cwd(), 'scripts', 'generate-spec-types.mts');
  try {
    execFileSync(process.execPath, ['--import', 'tsx', script, '--check'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string };
    assert.fail(
      `spec types are stale; run 'yarn generate:spec-types'\n${detail.stderr ?? ''}${detail.stdout ?? ''}`,
    );
  }
});
