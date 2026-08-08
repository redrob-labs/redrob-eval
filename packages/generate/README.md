# redrob-generate

Parametric generation of verifiable evaluation prompts and their verifiers, and the Python
reference implementation of the [Redrob Verifiable Task Spec v2](../../spec/verifiable-task-v2.md).

An evaluation item here is not a row in a file. It is a template plus a seed, and the seed is
derived from the generator version, the template id and the instance index rather than chosen.
Two consequences follow, and they are the reason the package exists:

- **The set cannot leak into pretraining before it is used,** because it does not exist until
  someone runs the generator. A published set is a set of *coordinates*; anyone can regenerate it,
  and anyone can generate a different one from the same template.
- **Cherry-picking is structurally impossible rather than discouraged.** A conventional seed such
  as `42` is unverifiable: a reader cannot tell one run from the best of twenty. A content-derived
  seed is recomputable by a third party from published values, so a set that was assembled by
  hand fails an audit that anyone can run.

Scoring is done by deterministic verifiers, not by a judge model. Nothing in this package makes a
network call, at generation time or at verification time, and a test fails the build if a socket
is opened.

## Install

Python 3.11 or newer. Apache-2.0.

```bash
pip install -e packages/generate          # from the repository root
pip install -e "packages/generate[dev]"   # plus pytest
```

Generation is optional for the workbench as a whole: `yarn install && yarn dev` works on a machine
with no Python at all, and nothing on the TypeScript side imports this package at build time.

## Two commands

### `redrob-generate emit`

```
redrob-generate emit --template <path> --count <n> --out <dir>
                     [--locale en] [--created-at <iso8601>]
                     [--doi <doi>] [--citation-year <year>] [--quiet]
```

Writes `instances.jsonl` (one instance per line) and `manifest.json` into `--out`. `--template`
takes a template directory or a single merged JSON file.

`--created-at` and `--citation-year` exist so that a rerun is byte-identical: the only thing in a
generated set that is not a function of its inputs is the clock, so the clock is an argument.

### `redrob-generate verify`

```
redrob-generate verify --set <dir> --outputs <path> --json [--no-executable]
```

Reads model outputs, runs each instance's verifier, and writes per-item results to stdout as JSON.
Exit code is `0` when every item passes, `1` when any item fails, and `2` on a usage error, so the
three cases are distinguishable in a script.

`--outputs` accepts JSONL of `{"instance_index": n, "output": "..."}`, a JSON array of the same
objects, a JSON array of bare strings read positionally, or a JSON object keyed by index. `-` reads
stdin. It deliberately does *not* accept one bare line per output: model outputs routinely contain
newlines, and that format would split an answer in half without saying so.

`--no-executable` refuses `sympy_equiv` and `python_unittest` instead of running them. Those two
verifiers evaluate model-derived text, so a caller that does not trust its inputs should pass it.

## A worked example

Generate three linear-equation items:

```console
$ redrob-generate emit --template templates/math/linear-equation --count 3 --out /tmp/set \
    --created-at 2026-01-01T00:00:00Z --citation-year 2026
3 instances of math.linear_equation [en] written to /tmp/set. Cite this set: DOI TBD, BibTeX in manifest.json.
```

The first instance, reformatted for reading (the file itself is one line, canonical JSON):

```json
{
  "spec_version": "redrob-verifiable-task/v2",
  "template_id": "math.linear_equation",
  "template_version": "1.0.0",
  "template_hash": "sha256:b7edd219a0af9a7df2d1dfb3c0d44851155deb4909c668c75baab43bf8cfbaf2",
  "instance_index": 0,
  "locale": "en",
  "seed": "10868130423516751893",
  "parameters": { "a": -5, "b": 28, "c": -36, "shift": -5 },
  "derived": { "answer": 13.8, "b_term": "+ 28", "rhs": -41, "shift_term": "- 5" },
  "prompt": "Solve the following equation for x.\n\n    -5x + 28 = -36 - 5\n\nReply with the value of x as a decimal number and nothing else. Round to four decimal places.",
  "verifier": { "type": "numeric_tolerance", "expected": 13.8, "abs_tol": 0.0001, "rel_tol": 1e-9, "trim": true }
}
```

The seed is not stored for convenience; it is stored so it can be checked. Recompute it yourself:

```console
$ python -c 'import hashlib; print(int.from_bytes(hashlib.sha256(b"0.1.0\x00math.linear_equation\x000").digest()[:8], "big"))'
10868130423516751893
```

Now score three model answers, one of which is wrong:

```console
$ cat outputs.jsonl
{"instance_index":0,"output":"13.8000"}
{"instance_index":1,"output":"-42"}
{"instance_index":2,"output":"17.99"}

$ redrob-generate verify --set /tmp/set --outputs outputs.jsonl --json
{"generator_name": "redrob-generate", "generator_version": "0.1.0", "instance_count": 3,
 "passed_count": 2, "results": [
  {"code": "ok", "instance_index": 0, "passed": true, "template_id": "math.linear_equation", "verifier_type": "numeric_tolerance"},
  {"code": "ok", "instance_index": 1, "passed": true, "template_id": "math.linear_equation", "verifier_type": "numeric_tolerance"},
  {"code": "out_of_tolerance", "instance_index": 2, "passed": false,
   "message": "difference 0.010000000000001563 exceeds tolerance 0.0001",
   "detail": {"candidate": 17.99, "expected": 18.0, "difference": 0.010000000000001563, "tolerance": 0.0001},
   "template_id": "math.linear_equation", "verifier_type": "numeric_tolerance"}],
 "set": "/tmp/set", "spec_version": "redrob-verifiable-task/v2"}

$ echo $?
1
```

The verdict carries a `code` as well as a boolean. The codes are normative and identical across
implementations; `message` and `detail` are for humans and are not compared by the conformance
suite, so either side can improve its diagnostics without breaking agreement.

## Layout

| Module | Responsibility |
| --- | --- |
| `spec.py` | load a template, merge its locale layer, validate against the JSON schema, hash it |
| `seed.py` | the content-derived seed |
| `prng.py` | SplitMix64, so that sampling does not depend on a language's stdlib RNG |
| `sample.py` | deterministic parameter sampling |
| `expr.py` | the restricted expression language used by template derivations |
| `render.py` | prompt rendering and verifier binding resolution |
| `verify/` | the declarative verifiers, the executable ones, and the shared subset validators |
| `canonical.py` | canonical JSON and content hashing |
| `manifest.py` | the manifest and its BibTeX entry |
| `fertility.py` | the token-count hook |
| `cli.py` | `emit` and `verify` |

## The two tiers of verifier

**Declarative** — `exact`, `numeric_tolerance`, `json_schema`, `regex`, `set_equality`,
`ordered_equality`, `format_constraint`, `all_of`. These must produce the same verdict in Python
and in TypeScript, and `spec/conformance/` is what forces them to.

**Executable** — `sympy_equiv`, `python_unittest`. Python only. The TypeScript implementation
raises an explicit unsupported-verifier error for these; it never skips them. A skipped verifier
reported as a success inflates every score computed from the run, and the inflation is invisible
in the output, which is the one failure mode this project cannot tolerate.

## Testing

```bash
pytest packages/generate -q
```

The suite includes the cross-language conformance cases in `spec/conformance/`, a fixture proving
the seed formula matches byte for byte, a determinism check on `emit`, and a test that fails if
any socket is opened during generation or declarative verification.

## Citation

Every generated set carries a BibTeX entry in its manifest so the citation travels with the data
rather than living only in a repository someone has to find. See `CITATION.cff` at the repository
root. The DOI is `TBD` until a Zenodo record is minted at first release.
