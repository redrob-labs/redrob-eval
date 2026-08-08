# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The restricted derivation expression language, per spec section 4.

Templates compute their own ground truth here: the answer to the equation, the facts
planted in a synthetic document, the reference JSON. The language is a whitelisted
subset of Python expression syntax evaluated over an AST we walk ourselves. There is no
attribute access, no assignment, no import machinery and no name outside the whitelist,
so a template cannot reach the filesystem or the network no matter what it contains.

This is generation-side only. TypeScript never evaluates it, because TypeScript never
generates.
"""

from __future__ import annotations

import ast
import math
from typing import Any, Callable, Mapping

from .canonical import canonical_json
from .errors import ExpressionError


def _fn_join(separator: str, items: Any) -> str:
    return separator.join(str(item) for item in items)


def _fn_lower(value: str) -> str:
    return str(value).lower()


def _fn_upper(value: str) -> str:
    return str(value).upper()


def _fn_title(value: str) -> str:
    return str(value).title()


def _fn_strip(value: str, chars: str | None = None) -> str:
    return str(value).strip(chars) if chars is not None else str(value).strip()


def _fn_replace(value: str, old: str, new: str) -> str:
    return str(value).replace(old, new)


# Attribute access is not in the language, so the handful of string operations a
# template legitimately needs are exposed as free functions instead.
ALLOWED_FUNCTIONS: dict[str, Callable[..., Any]] = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    # Templates that ask a model for minified JSON need to state the exact expected
    # string, and canonical JSON is the one serialisation both implementations agree on.
    "canonical_json": canonical_json,
    "dict": dict,
    "divmod": divmod,
    "enumerate": enumerate,
    "float": float,
    "format": format,
    "int": int,
    "join": _fn_join,
    "len": len,
    "list": list,
    "lower": _fn_lower,
    "max": max,
    "min": min,
    "pow": pow,
    "range": range,
    "replace": _fn_replace,
    "round": round,
    "sorted": sorted,
    "str": str,
    "strip": _fn_strip,
    "sum": sum,
    "title": _fn_title,
    "upper": _fn_upper,
    "zip": zip,
}

_BIN_OPS: dict[type, Callable[[Any, Any], Any]] = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
    ast.Pow: lambda a, b: a**b,
}

_CMP_OPS: dict[type, Callable[[Any, Any], Any]] = {
    ast.Eq: lambda a, b: a == b,
    ast.NotEq: lambda a, b: a != b,
    ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b,
    ast.Gt: lambda a, b: a > b,
    ast.GtE: lambda a, b: a >= b,
    ast.In: lambda a, b: a in b,
    ast.NotIn: lambda a, b: a not in b,
}

# Exponentiation is the one operator here that can burn a machine with three characters,
# so the exponent is bounded rather than trusted.
MAX_EXPONENT = 64


class _Evaluator:
    def __init__(self, scope: Mapping[str, Any], source: str) -> None:
        self._scope = dict(scope)
        self._source = source

    def fail(self, node: ast.AST, message: str) -> ExpressionError:
        return ExpressionError(f"{message} (in expression {self._source!r})")

    def eval(self, node: ast.AST) -> Any:
        method = getattr(self, f"_eval_{type(node).__name__}", None)
        if method is None:
            raise self.fail(node, f"{type(node).__name__} is not allowed")
        return method(node)

    # -- leaves ---------------------------------------------------------------

    def _eval_Expression(self, node: ast.Expression) -> Any:
        return self.eval(node.body)

    def _eval_Constant(self, node: ast.Constant) -> Any:
        if isinstance(node.value, (int, float, str, bool)) or node.value is None:
            return node.value
        raise self.fail(node, f"constant of type {type(node.value).__name__} is not allowed")

    def _eval_Name(self, node: ast.Name) -> Any:
        if node.id in self._scope:
            return self._scope[node.id]
        if node.id in ALLOWED_FUNCTIONS:
            return ALLOWED_FUNCTIONS[node.id]
        raise self.fail(node, f"name {node.id!r} is not bound and not a whitelisted function")

    # -- operators ------------------------------------------------------------

    def _eval_BinOp(self, node: ast.BinOp) -> Any:
        handler = _BIN_OPS.get(type(node.op))
        if handler is None:
            raise self.fail(node, f"operator {type(node.op).__name__} is not allowed")
        left = self.eval(node.left)
        right = self.eval(node.right)
        if isinstance(node.op, ast.Pow) and isinstance(right, (int, float)) and right > MAX_EXPONENT:
            raise self.fail(node, f"exponent {right} exceeds the limit of {MAX_EXPONENT}")
        try:
            return handler(left, right)
        except ZeroDivisionError as exc:
            raise self.fail(node, "division by zero") from exc

    def _eval_UnaryOp(self, node: ast.UnaryOp) -> Any:
        operand = self.eval(node.operand)
        if isinstance(node.op, ast.USub):
            return -operand
        if isinstance(node.op, ast.UAdd):
            return +operand
        if isinstance(node.op, ast.Not):
            return not operand
        raise self.fail(node, f"unary operator {type(node.op).__name__} is not allowed")

    def _eval_BoolOp(self, node: ast.BoolOp) -> Any:
        if isinstance(node.op, ast.And):
            result: Any = True
            for value in node.values:
                result = self.eval(value)
                if not result:
                    return result
            return result
        result = False
        for value in node.values:
            result = self.eval(value)
            if result:
                return result
        return result

    def _eval_Compare(self, node: ast.Compare) -> Any:
        left = self.eval(node.left)
        for operator, comparator in zip(node.ops, node.comparators):
            handler = _CMP_OPS.get(type(operator))
            if handler is None:
                raise self.fail(node, f"comparison {type(operator).__name__} is not allowed")
            right = self.eval(comparator)
            if not handler(left, right):
                return False
            left = right
        return True

    def _eval_IfExp(self, node: ast.IfExp) -> Any:
        return self.eval(node.body) if self.eval(node.test) else self.eval(node.orelse)

    # -- displays -------------------------------------------------------------

    def _eval_List(self, node: ast.List) -> Any:
        return [self.eval(item) for item in node.elts]

    def _eval_Tuple(self, node: ast.Tuple) -> Any:
        return [self.eval(item) for item in node.elts]

    def _eval_Set(self, node: ast.Set) -> Any:
        return {self.eval(item) for item in node.elts}

    def _eval_Dict(self, node: ast.Dict) -> Any:
        result: dict[Any, Any] = {}
        for key_node, value_node in zip(node.keys, node.values):
            if key_node is None:
                raise self.fail(node, "dict unpacking is not allowed")
            result[self.eval(key_node)] = self.eval(value_node)
        return result

    def _eval_Subscript(self, node: ast.Subscript) -> Any:
        container = self.eval(node.value)
        key = self.eval(node.slice)
        try:
            return container[key]
        except (KeyError, IndexError, TypeError) as exc:
            raise self.fail(node, f"subscript failed: {exc}") from exc

    def _eval_Slice(self, node: ast.Slice) -> Any:
        lower = self.eval(node.lower) if node.lower is not None else None
        upper = self.eval(node.upper) if node.upper is not None else None
        step = self.eval(node.step) if node.step is not None else None
        return slice(lower, upper, step)

    def _eval_ListComp(self, node: ast.ListComp) -> Any:
        if len(node.generators) != 1:
            raise self.fail(node, "only a single-generator comprehension is allowed")
        generator = node.generators[0]
        if generator.is_async:
            raise self.fail(node, "async comprehensions are not allowed")
        if not isinstance(generator.target, ast.Name):
            raise self.fail(node, "comprehension target must be a plain name")
        target = generator.target.id
        iterable = self.eval(generator.iter)
        shadowed = self._scope.get(target, _MISSING)
        results = []
        try:
            for item in iterable:
                self._scope[target] = item
                if all(self.eval(condition) for condition in generator.ifs):
                    results.append(self.eval(node.elt))
        finally:
            if shadowed is _MISSING:
                self._scope.pop(target, None)
            else:
                self._scope[target] = shadowed
        return results

    # -- strings --------------------------------------------------------------

    def _eval_JoinedStr(self, node: ast.JoinedStr) -> str:
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                parts.append(str(value.value))
            elif isinstance(value, ast.FormattedValue):
                parts.append(self._eval_FormattedValue(value))
            else:
                raise self.fail(node, "unsupported f-string component")
        return "".join(parts)

    def _eval_FormattedValue(self, node: ast.FormattedValue) -> str:
        if node.conversion not in (-1, 115):  # -1 is none, 115 is !s
            raise self.fail(node, "only the !s conversion is allowed in f-strings")
        value = self.eval(node.value)
        spec = ""
        if node.format_spec is not None:
            if not isinstance(node.format_spec, ast.JoinedStr) or not all(
                isinstance(part, ast.Constant) for part in node.format_spec.values
            ):
                raise self.fail(node, "f-string format specs must be constant")
            spec = "".join(str(part.value) for part in node.format_spec.values)  # type: ignore[attr-defined]
        return format(value, spec)

    # -- calls ----------------------------------------------------------------

    def _eval_Call(self, node: ast.Call) -> Any:
        if not isinstance(node.func, ast.Name):
            raise self.fail(node, "only calls to whitelisted named functions are allowed")
        name = node.func.id
        if name not in ALLOWED_FUNCTIONS:
            raise self.fail(node, f"function {name!r} is not whitelisted")
        if any(isinstance(arg, ast.Starred) for arg in node.args):
            raise self.fail(node, "argument unpacking is not allowed")
        args = [self.eval(arg) for arg in node.args]
        kwargs: dict[str, Any] = {}
        for keyword in node.keywords:
            if keyword.arg is None:
                raise self.fail(node, "keyword unpacking is not allowed")
            kwargs[keyword.arg] = self.eval(keyword.value)
        try:
            return ALLOWED_FUNCTIONS[name](*args, **kwargs)
        except ExpressionError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported as a template error, not a crash
            raise self.fail(node, f"call to {name!r} failed: {exc}") from exc


class _Missing:
    pass


_MISSING = _Missing()


def evaluate(expression: str, scope: Mapping[str, Any]) -> Any:
    """Evaluate one derivation expression against ``scope``."""
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise ExpressionError(f"could not parse expression {expression!r}: {exc}") from exc
    return _Evaluator(scope, expression).eval(tree)


def evaluate_derivations(
    derivations: list[Mapping[str, Any]],
    scope: Mapping[str, Any],
) -> dict[str, Any]:
    """Evaluate derivations in order, each seeing the results of the ones before it."""
    working = dict(scope)
    derived: dict[str, Any] = {}
    for derivation in derivations:
        name = derivation["name"]
        value = evaluate(derivation["expr"], working)
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            # A non-finite derived value cannot be canonicalised, so it would blow up
            # later at hashing time with a much less helpful message than this one.
            raise ExpressionError(f"derivation {name!r} produced a non-finite value: {value!r}")
        working[name] = value
        derived[name] = value
    return derived
