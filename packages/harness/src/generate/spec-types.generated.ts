// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
//
// GENERATED FILE - DO NOT EDIT.
// Source: spec/verifiable-task-v2.schema.json
// Regenerate: yarn generate:spec-types
//
// Types are derived from the JSON Schema rather than written by hand, so that the
// schema stays the single definition of every document shape in the spec.

/**
 * Identifier of the specification revision a document conforms to.
 */
export type SpecVersion = "redrob-verifiable-task/v2";

/**
 * BCP 47 language tag, restricted to a language subtag with an optional script subtag and an optional region subtag. The script subtag is what makes Hinglish expressible as hi-Latn: Hindi written in Latin script is a different tokenisation problem from Hindi in Devanagari, so it has to be a different locale rather than a different template.
 */
export type Locale = string;

/**
 * How much human review a locale's prompt text has had. This is metadata about the text rather than about the task, so it belongs to the locale layer. untranslated means the prompt is a placeholder -- in practice the English text copied verbatim -- which is enough to exercise a pipeline end to end and never enough to publish a result from. A publishable artifact refuses to build while any locale it covers is untranslated.
 */
export type TranslationStatus = "native-reviewed" | "single-reviewer" | "untranslated";

/**
 * Major.minor.patch version string.
 */
export type Semver = string;

/**
 * Stable dotted identifier shared by every locale variant of a template.
 */
export type TemplateId = string;

/**
 * Lowercase hex SHA-256 of a canonical JSON serialisation, prefixed with the algorithm name.
 */
export type ContentHash = string;

/**
 * Declaration of one sampled parameter. The declaration order is the sampling order and is therefore load bearing.
 */
export type Parameter = {
  /** Binding name, usable in the prompt body and in derivation expressions. */
  "name": string;
  /** Sampling strategy for this parameter. */
  "type": "integer" | "number" | "boolean" | "choice" | "subset" | "permutation";
  /** Human-readable note; ignored by the sampler. */
  "description"?: string;
  /** Inclusive lower bound for integer and number parameters. */
  "min"?: number;
  /** Inclusive upper bound for integer and number parameters. */
  "max"?: number;
  /** Number of decimal places a number parameter is rounded to, half away from zero. */
  "decimals"?: number;
  /** Values rejected by the sampler; drawing repeats until an accepted value appears. */
  "exclude"?: unknown[];
  /** Candidate values for choice, subset and permutation parameters. */
  "choices"?: unknown[];
  /** Number of elements drawn by a subset parameter. */
  "size"?: number;
};

/**
 * A named value computed from parameters and earlier derivations by the restricted generation-side expression language. Derivations are evaluated in array order.
 */
export type Derivation = {
  "name": string;
  /** Expression in the restricted language documented in the spec prose. */
  "expr": string;
  "description"?: string;
};

/**
 * String equality after a declared normalisation pipeline.
 */
export type ExactVerifier = {
  "type": "exact";
  "expected": string;
  /** Unicode normalisation form applied to both sides before comparison. NFC by default because two answers a reader cannot tell apart must not score differently: Hangul U+AC00 and the jamo pair U+1100 U+1161 render identically and compare unequal without it. 'none' exists for byte-exactness tests and is deliberately not the default. */
  "normalization"?: "none" | "NFC" | "NFD" | "NFKC" | "NFKD";
  /** Rewrite CRLF and lone CR to LF before comparing. */
  "normalize_line_endings"?: boolean;
  /** Strip leading and trailing spec whitespace. */
  "trim"?: boolean;
  /** Replace each run of spec whitespace with a single U+0020. */
  "collapse_whitespace"?: boolean;
  /** When false, both sides are lowercased with the default Unicode lowercase mapping. */
  "case_sensitive"?: boolean;
};

/**
 * Parse the candidate as a single number and compare it to the expected value within tolerance.
 */
export type NumericToleranceVerifier = {
  "type": "numeric_tolerance";
  /** Finite number, or one of the non-finite tokens as a string. */
  "expected": number | "NaN" | "Infinity" | "-Infinity";
  /** Absolute tolerance. The candidate passes when |c - e| <= max(abs_tol, rel_tol * |e|). */
  "abs_tol"?: number;
  /** Relative tolerance, taken against the magnitude of the expected value. */
  "rel_tol"?: number;
  /** When true a NaN candidate satisfies a NaN expectation. Off by default because NaN is usually a bug, not an answer. */
  "nan_matches_nan"?: boolean;
  /** Remove ASCII commas before parsing. */
  "allow_thousands_separator"?: boolean;
  /** Strip leading and trailing spec whitespace before parsing. */
  "trim"?: boolean;
};

/**
 * Parse the candidate as JSON and validate it against a schema drawn from the documented draft 2020-12 keyword subset.
 */
export type JsonSchemaVerifier = {
  "type": "json_schema";
  /** JSON Schema draft 2020-12 document, restricted to the keyword subset in the spec prose. */
  "schema": {
    [key: string]: unknown;
  } | boolean;
  /** Unicode normalisation form applied to every string and every object key in the parsed candidate before validation. The schema itself is not rewritten: it must already be in this form, and is rejected at configuration time otherwise, because a const written in another form would silently never match. */
  "normalization"?: "none" | "NFC" | "NFD" | "NFKC" | "NFKD";
};

/**
 * Match the candidate against a pattern drawn from the documented portable regex subset. There are no flags: the subset has no construct a flag could modify, and case folding is written out as [kK] because the two engines fold U+0130 and U+0131 differently.
 */
export type RegexVerifier = {
  "type": "regex";
  /** A pattern from the portable regex subset. The subset has no '^' and no '$': anchoring is the job of 'mode'. */
  "pattern": string;
  /** full_match requires the pattern to consume the entire candidate; search requires a match anywhere. This is the only way to anchor, because the subset has no anchors. */
  "mode"?: "full_match" | "search";
};

/**
 * How a candidate string is split into a list of elements.
 */
export type ElementParse = {
  "mode": "json_array" | "lines" | "delimiter";
  /** Literal delimiter for delimiter mode. */
  "delimiter"?: string;
  /** Strip spec whitespace from each element after splitting. */
  "trim_elements"?: boolean;
  /** Discard empty elements after trimming. */
  "drop_empty"?: boolean;
};

/**
 * Unordered comparison of a parsed element list against the expected list.
 */
export type SetEqualityVerifier = {
  "type": "set_equality";
  "expected": unknown[];
  "parse": ElementParse;
  "element_comparator"?: "exact_string" | "case_insensitive_string" | "numeric" | "json";
  /** Unicode normalisation form applied to every parsed element and every expected element before comparison. NFC by default; 'none' is byte-exactness. */
  "normalization"?: "none" | "NFC" | "NFD" | "NFKC" | "NFKD";
  "numeric_abs_tol"?: number;
  "numeric_rel_tol"?: number;
  /** collapse compares deduplicated collections, significant compares multisets. */
  "duplicates"?: "collapse" | "significant";
};

/**
 * Position-by-position comparison of a parsed element list against the expected list.
 */
export type OrderedEqualityVerifier = {
  "type": "ordered_equality";
  "expected": unknown[];
  "parse": ElementParse;
  "element_comparator"?: "exact_string" | "case_insensitive_string" | "numeric" | "json";
  /** Unicode normalisation form applied to every parsed element and every expected element before comparison. NFC by default; 'none' is byte-exactness. */
  "normalization"?: "none" | "NFC" | "NFD" | "NFKC" | "NFKD";
  "numeric_abs_tol"?: number;
  "numeric_rel_tol"?: number;
};

/**
 * Shape checks that do not look at meaning: length in code points, line count, required and forbidden substrings.
 */
export type FormatConstraintVerifier = {
  "type": "format_constraint";
  /** Unit the length bounds are measured in. codepoints is Python's len() and the iteration order of a JavaScript string; utf16 is String.prototype.length; bytes_utf8 is the UTF-8 encoded size. graphemes is specified and refused by both implementations rather than approximated, because the two runtimes carry different Unicode versions and two UAX #29 breakers drawn from different tables would disagree on exactly the sequences the unit exists for. */
  "length_unit"?: "codepoints" | "utf16" | "graphemes" | "bytes_utf8";
  "min_length"?: number;
  "max_length"?: number;
  "min_lines"?: number;
  "max_lines"?: number;
  "required_substrings"?: string[];
  "forbidden_substrings"?: string[];
  /** Applies to substring checks only. */
  "case_sensitive"?: boolean;
  /** Strip spec whitespace before every check. */
  "trim"?: boolean;
  /** Rewrite CRLF and lone CR to LF before every check. */
  "normalize_line_endings"?: boolean;
  /** Unicode normalisation form applied to the candidate and to every required and forbidden substring, before the length is measured. The order matters: NFC turns "cafe\u0301" from six code points into five. */
  "normalization"?: "none" | "NFC" | "NFD" | "NFKC" | "NFKD";
};

/**
 * Executable tier. Symbolic equivalence of the candidate expression and the expected expression. Python only.
 */
export type SympyEquivVerifier = {
  "type": "sympy_equiv";
  /** Expected expression in SymPy input syntax. */
  "expected": string;
  /** Free symbols declared for parsing, so that an undeclared name is an error rather than a silent new symbol. */
  "symbols"?: string[];
  /** simplify_zero subtracts and simplifies; equals uses SymPy's structural/numeric equals. */
  "mode"?: "simplify_zero" | "equals";
  /** Literal prefixes removed from the candidate before parsing, such as an answer label. */
  "strip_prefixes"?: string[];
};

/**
 * Executable tier. Run supplied unittest source against the candidate output. Python only, and only in a sandbox the operator has consented to.
 */
export type PythonUnittestVerifier = {
  "type": "python_unittest";
  /** Python source defining unittest.TestCase subclasses. The candidate is importable as the module named by candidate_module. */
  "test_source": string;
  /** Module name the candidate output is written to before the tests import it. */
  "candidate_module"?: string;
  "timeout_seconds"?: number;
};

/**
 * The declarative tier only. Every member must produce an identical verdict in every implementation, which is what the conformance suite enforces. Referenced wherever an executable verifier would be unsafe to permit, chiefly as an element of a verifier list.
 */
export type DeclarativeVerifier = ExactVerifier | NumericToleranceVerifier | JsonSchemaVerifier | RegexVerifier | SetEqualityVerifier | OrderedEqualityVerifier | FormatConstraintVerifier;

/**
 * An ordered list of declarative verifiers, all of which must pass. Elements reference verifier_declarative rather than verifier, so an executable element is a schema violation rather than a runtime error: a list that could hide an executable verifier among declarative ones is a way to obtain a verdict from partially checked output. Elements are objects, so a list cannot contain a list; there is no nesting and therefore no depth limit. An empty list passes.
 */
export type VerifierList = DeclarativeVerifier[];

/**
 * Tagged union of every verifier type. Types exact through format_constraint are the declarative tier and must behave identically in every implementation. Types sympy_equiv and python_unittest are the executable tier and are Python only.
 */
export type Verifier = DeclarativeVerifier | SympyEquivVerifier | PythonUnittestVerifier;

/**
 * What a verifier field holds: one verifier, or a list of declarative verifiers all of which must pass. The two forms are not interchangeable in one respect, and it is deliberate: the single form admits an executable verifier and the list form does not.
 */
export type VerifierOrList = Verifier | VerifierList;

/**
 * A verifier as written in a template: the same tagged union, but any string leaf may be a derivation reference of the form {{name}} that the generator resolves per instance.
 */
export type VerifierBinding = {
  "type": "exact" | "numeric_tolerance" | "json_schema" | "regex" | "set_equality" | "ordered_equality" | "format_constraint" | "sympy_equiv" | "python_unittest";
  [key: string]: unknown;
};

/**
 * A declarative verifier as written in a template. The type enum omits the executable tier, which is what makes an executable element of a verifier list a schema violation at load time rather than a refusal at scoring time.
 */
export type DeclarativeVerifierBinding = {
  "type": "exact" | "numeric_tolerance" | "json_schema" | "regex" | "set_equality" | "ordered_equality" | "format_constraint";
  [key: string]: unknown;
};

/**
 * A template's verifier field: one verifier binding, or a list of declarative bindings all of which must pass.
 */
export type VerifierBindingOrList = VerifierBinding | DeclarativeVerifierBinding[];

/**
 * Closed set of outcome codes. Codes are normative: two implementations that disagree on a code have diverged, even if they agree on pass or fail.
 */
export type VerdictCode = "ok" | "mismatch" | "not_a_number" | "out_of_tolerance" | "nan_mismatch" | "infinity_mismatch" | "invalid_json" | "schema_violation" | "no_match" | "invalid_pattern" | "parse_error" | "cardinality_mismatch" | "element_mismatch" | "length_out_of_bounds" | "line_count_out_of_bounds" | "missing_required_substring" | "forbidden_substring_present" | "unsupported_verifier";

/**
 * One entry of the per-element report a verifier list produces. Unlike the rest of detail, these are normative and are compared by the conformance suite: a collapsed boolean cannot say which element failed, and a per-element report that two implementations disagree about is worse than none.
 */
export type VerdictElement = {
  /** Position of the element in the verifier list, zero based. */
  "index": number;
  "type": string;
  "passed": boolean;
  "code": VerdictCode;
};

/**
 * Result of running one verifier against one candidate. passed and code are normative; message and detail are advisory and may differ between implementations, with one exception: when the verifier field held a list, detail.elements is normative and holds one verdict_element per element, in list order.
 */
export type Verdict = {
  "passed": boolean;
  "code": VerdictCode;
  "message"?: string;
  "detail"?: {
    "elements"?: VerdictElement[];
    [key: string]: unknown;
  };
};

/**
 * A parametric task family. This is the merged form: on disk a template is usually split into a locale-neutral core and one file per locale, and the loader merges them into this shape before validation.
 */
export type Template = {
  "spec_version": SpecVersion;
  "id": TemplateId;
  "version": Semver;
  "locale": Locale;
  "translation_status": TranslationStatus;
  /** Coarse grouping used for reporting, for example math or extraction. */
  "family"?: string;
  "description"?: string;
  "parameters": Parameter[];
  "derivations"?: Derivation[];
  /** Prompt body. {name} interpolates a parameter or derivation; {{ and }} are literal braces. */
  "prompt": string;
  "verifier": VerifierBindingOrList;
  "notes"?: string;
};

/**
 * Token counts for one instance under one named tokenizer. Generated items carry identical semantic content across locales, so these counts are directly comparable between locales in a way corpus-level fertility statistics are not.
 */
export type Fertility = {
  "tokenizer_name": string;
  "tokenizer_version": string;
  "prompt_tokens": number;
  "prompt_characters": number;
  "tokens_per_character": number;
};

/**
 * One generated task: a template, the parameter values bound to it, the seed those values came from, the rendered prompt, and the expected result computed at generation time.
 */
export type Instance = {
  "spec_version": SpecVersion;
  "template_id": TemplateId;
  "template_version": Semver;
  "template_hash": ContentHash;
  "locale": Locale;
  "instance_index": number;
  /** Derived uint64 seed, written as a decimal string so that no JSON reader loses precision. */
  "seed": string;
  "parameters": {
    [key: string]: unknown;
  };
  "derived"?: {
    [key: string]: unknown;
  };
  "prompt": string;
  "verifier": VerifierOrList;
  "fertility"?: Fertility;
  /** Proportion of an instance's prompt drawn from the embedded language in a code-mixed locale such as hi-Latn. Always null at present. The field exists so that the artifact shape does not change when a measurement is defined, and it is null rather than absent so that a reader can tell 'not measured' from 'this reader is looking at an older artifact'. Defining the measurement is a human decision -- it requires choosing a token unit, a language identifier and a treatment of proper nouns and numerals, and each choice produces a different number for the same sentence -- so no value is invented here. */
  "code_mix_ratio": number | null;
};

export type ManifestTemplateEntry = {
  "id": TemplateId;
  "version": Semver;
  "locale": Locale;
  "content_hash": ContentHash;
  "instance_count": number;
};

export type ManifestCitation = {
  "doi": string;
  "bibtex": string;
  "notice": string;
};

export type ManifestSeedDerivation = {
  "method": "sha256-prefix-uint64-be";
  "formula": string;
  "inputs": string[];
};

/**
 * Present only when a tokenizer was supplied. No tokenizer ships with the generator, so this is null in a default run.
 */
export type ManifestFertility = {
  "tokenizer_name": string;
  "tokenizer_version": string;
  "instances_measured": number;
  "total_prompt_tokens": number;
  "total_prompt_characters": number;
  "mean_tokens_per_character": number;
};

/**
 * Emitted alongside every generated set. Everything a third party needs to regenerate the set and to cite it.
 */
export type Manifest = {
  "spec_version": SpecVersion;
  "generator_name": string;
  "generator_version": Semver;
  "tool": {
    "name": string;
    "version": string;
  };
  /** RFC 3339 UTC timestamp. The only field that legitimately differs between two otherwise identical runs. */
  "created_at": string;
  "locale": Locale;
  "instance_count": number;
  "templates": ManifestTemplateEntry[];
  "seed_derivation": ManifestSeedDerivation;
  "fertility"?: ManifestFertility;
  "citation": ManifestCitation;
};

/**
 * One executable row of the cross-language conformance suite.
 */
export type ConformanceCase = {
  "id": string;
  "description"?: string;
  "verifier": VerifierOrList;
  "candidate": string;
  "expected": {
    "passed": boolean;
    "code": VerdictCode;
    /** Required when the verifier is a list, forbidden otherwise. Compared entry for entry, so an implementation that reaches the right overall verdict by running the wrong elements fails the row. */
    "elements"?: VerdictElement[];
  };
};

/**
 * One row of the suite asserting that a verifier configuration is refused rather than evaluated. The verifier here is deliberately typed as a bare object or array, because these configurations are invalid by construction and could not appear in a field typed as #/$defs/verifier_or_list. Strict dispatch must raise the named error; lenient dispatch must return the stated verdict, which is always a failure.
 */
export type ConformanceRejection = {
  "id": string;
  "description"?: string;
  "verifier": Record<string, unknown> | unknown[];
  "candidate": string;
  /** unsupported_verifier for a type this implementation must refuse; verifier_config for a configuration that is malformed rather than unsupported. */
  "raises": "unsupported_verifier" | "verifier_config";
  "expected": {
    "passed": false;
    "code": VerdictCode;
  };
};

/**
 * One row of the suite asserting that a document is refused by schema validation, before any verifier runs. A runtime refusal and a structural one are different guarantees: the first depends on the dispatcher being reached, the second holds for any tool that validates the document, including ones this project did not write. Rows of this kind are checked with a general JSON Schema validator, not with the subset validator the json_schema verifier uses.
 */
export type ConformanceSchemaRejection = {
  "id": string;
  "description"?: string;
  /** Name under #/$defs that the document is validated against. */
  "definition": string;
  /** The document that must fail validation. Untyped, because it is invalid by construction. */
  "document": unknown;
  /** A near-identical document that must validate, so the row cannot pass because of an unrelated defect in the document. */
  "valid_counterpart": unknown;
};

export type ConformanceFile = {
  "spec_version": SpecVersion;
  "verifier_type": string;
  "description"?: string;
  "cases": ConformanceCase[];
  "rejections"?: ConformanceRejection[];
  "schema_rejections"?: ConformanceSchemaRejection[];
};

export const TRANSLATION_STATUSS = [
  "native-reviewed",
  "single-reviewer",
  "untranslated",
] as const satisfies readonly TranslationStatus[];

export const VERDICT_CODES = [
  "ok",
  "mismatch",
  "not_a_number",
  "out_of_tolerance",
  "nan_mismatch",
  "infinity_mismatch",
  "invalid_json",
  "schema_violation",
  "no_match",
  "invalid_pattern",
  "parse_error",
  "cardinality_mismatch",
  "element_mismatch",
  "length_out_of_bounds",
  "line_count_out_of_bounds",
  "missing_required_substring",
  "forbidden_substring_present",
  "unsupported_verifier",
] as const satisfies readonly VerdictCode[];
