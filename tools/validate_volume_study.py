"""Validate the volume study's shader equations against analytical references.

This executes the scalar WGSL/GLSL helpers extracted from the renderer, not a
second hand-written implementation of their formulas. It checks homogeneous
single-scattering slabs, a known heterogeneous optical-depth integral, and HG
normalization/direction. It does not establish GPU pixel agreement or make the
finite-step heterogeneous renderer an unbiased multiple-scattering simulation.

References:
https://www.pbr-book.org/4ed/Volume_Scattering/Transmittance
https://www.pbr-book.org/4ed/Volume_Scattering/Phase_Functions
"""

from __future__ import annotations

import argparse
import ast
import json
import math
import operator
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BIN_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
}
CMP_OPS = {
    ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt,
    ast.GtE: operator.ge, ast.Eq: operator.eq, ast.NotEq: operator.ne,
}
CALLS = {
    "exp": math.exp, "sqrt": math.sqrt, "pow": math.pow, "abs": abs,
    "max": max, "min": min, "f32": float,
    "clamp": lambda x, lo, hi: max(lo, min(hi, x)),
    "select": lambda a, b, condition: b if condition else a,
}


def expression(text: str) -> ast.AST:
    text = re.sub(r"(?<=\d)f\b", "", text.strip())
    text = text.replace("&&", " and ").replace("||", " or ")
    text = re.sub(r"!(?!=)", " not ", text)
    text = re.sub(r"\btrue\b", "True", text)
    text = re.sub(r"\bfalse\b", "False", text)
    return ast.parse(text.strip(), mode="eval").body


def calculate(node: ast.AST, values: dict[str, float]) -> float:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float, bool)):
        return node.value
    if isinstance(node, ast.Name):
        return values[node.id]
    if isinstance(node, ast.BinOp) and type(node.op) in BIN_OPS:
        return BIN_OPS[type(node.op)](calculate(node.left, values), calculate(node.right, values))
    if isinstance(node, ast.UnaryOp):
        value = calculate(node.operand, values)
        if isinstance(node.op, ast.USub): return -value
        if isinstance(node.op, ast.UAdd): return value
        if isinstance(node.op, ast.Not): return not value
    if isinstance(node, ast.Compare):
        left = calculate(node.left, values)
        for op, right_node in zip(node.ops, node.comparators):
            right = calculate(right_node, values)
            if type(op) not in CMP_OPS or not CMP_OPS[type(op)](left, right): return False
            left = right
        return True
    if isinstance(node, ast.BoolOp):
        operands = [calculate(item, values) for item in node.values]
        return all(operands) if isinstance(node.op, ast.And) else any(operands)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in CALLS:
        return CALLS[node.func.id](*(calculate(item, values) for item in node.args))
    raise ValueError(f"Unsupported scalar shader expression: {ast.dump(node)}")


def closing_brace(source: str, start: int) -> int:
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{": depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0: return index
    raise ValueError("Unclosed shader function")


def statements(body: str) -> list:
    result = []
    body = re.sub(r"//[^\n]*|/\*[\s\S]*?\*/", "", body)
    while body.strip():
        body = body.lstrip()
        if body.startswith("if") and re.match(r"if\b", body):
            after_if = body[2:].lstrip()
            if after_if.startswith("("):
                depth = 0
                end = 0
                for end, char in enumerate(after_if):
                    if char == "(": depth += 1
                    elif char == ")":
                        depth -= 1
                        if depth == 0: break
                condition = after_if[1:end]
                tail = after_if[end + 1:].lstrip()
            else:
                open_at = after_if.index("{")
                condition, tail = after_if[:open_at], after_if[open_at:]
            if tail.startswith("{"):
                end = closing_brace(tail, 0)
                branch, body = tail[1:end], tail[end + 1:]
            else:
                end = tail.index(";")
                branch, body = tail[:end + 1], tail[end + 1:]
            result.append(("if", expression(condition), statements(branch)))
            continue
        semi = body.index(";")
        statement, body = body[:semi].strip(), body[semi + 1:]
        if statement.startswith("return "):
            result.append(("return", expression(statement[7:])))
            continue
        declaration = re.fullmatch(r"(?:let|var|const|float)\s+(\w+)(?:\s*:\s*f32)?\s*=\s*(.+)", statement)
        if declaration:
            result.append(("let", declaration[1], expression(declaration[2])))
            continue
        raise ValueError(f"Unsupported scalar shader statement: {statement}")
    return result


def run_statements(code: list, values: dict[str, float]):
    for item in code:
        if item[0] == "let": values[item[1]] = calculate(item[2], values)
        elif item[0] == "return": return True, calculate(item[1], values)
        elif item[0] == "if" and calculate(item[1], values):
            returned, value = run_statements(item[2], values)
            if returned: return True, value
    return False, None


class ShaderFunction:
    def __init__(self, source: str, name: str, language: str):
        signature = (rf"\bfn\s+{name}\s*\(([^)]*)\)\s*->\s*f32\s*\{{" if language == "WGSL"
                     else rf"\bfloat\s+{name}\s*\(([^)]*)\)\s*\{{")
        match = re.search(signature, source)
        if not match: raise ValueError(f"Missing {language} helper {name}")
        self.parameters = ([item.strip().split(":")[0] for item in match[1].split(",")]
                           if language == "WGSL" else
                           [item.strip().split()[-1] for item in match[1].split(",")])
        self.code = statements(source[match.end():closing_brace(source, match.end() - 1)])
        self.constants = {}
        numeric_source = source[:match.start()].replace("${Math.PI}", repr(math.pi)).replace("Math.PI", repr(math.pi))
        for constant in re.finditer(r"\bconst\s+(?:float\s+)?([A-Z][A-Z0-9_]*)\s*(?::\s*f32)?\s*=\s*([^;{}\n]+);", numeric_source):
            try:
                self.constants[constant[1]] = calculate(expression(constant[2]), self.constants)
            except (KeyError, ValueError, SyntaxError):
                pass  # Unrelated vector, resource, or JavaScript constants are not scalar helpers.

    def __call__(self, *args: float) -> float:
        values = dict(self.constants)
        values.update(zip(self.parameters, args))
        returned, result = run_statements(self.code, values)
        if not returned: raise ValueError("Shader helper did not return a value")
        return result


def near(actual: float, expected: float, tolerance: float = 1e-10, name: str = "value"):
    if not math.isfinite(actual) or abs(actual - expected) > tolerance:
        raise AssertionError(f"{name}: {actual!r}, expected {expected!r} ± {tolerance}")


def integrate(transmission, weight, sigma_a, sigma_s, distance, steps, density, incident=1.7, phase=0.08):
    transmittance, radiance = 1.0, 0.0
    ds = distance / steps
    for step in range(steps):
        rho = density((step + 0.5) * ds)
        segment_t = transmission(sigma_a + sigma_s, rho, ds)
        radiance += transmittance * incident * phase * weight(sigma_a, sigma_s, segment_t)
        transmittance *= segment_t
    return transmittance, radiance


def simpson(function, start, end, intervals=8192):
    ds = (end - start) / intervals
    total = function(start) + function(end)
    for index in range(1, intervals):
        total += (4 if index % 2 else 2) * function(start + index * ds)
    return total * ds / 3


def check_source_contract(source: str, model: dict):
    """Ensure the tested helpers actually drive the displayed ray-march model."""
    for name, prefix in (("wgsl", "params.optics"), ("glFragment", "uOptics")):
        shader = re.search(rf"\bconst\s+{name}\s*=\s*`([\s\S]*?)`;", source)
        if not shader: raise ValueError(f"Missing shader template {name}")
        code = re.sub(r"\s+", "", re.sub(r"//[^\n]*", "", shader[1]))
        required = (
            f"sigmaT={prefix}.x+{prefix}.y",
            "transmittance=segmentT(sigmaT,density,ds)",
            f"phaseHG(clamp(dot(rd,toLight),-1.0,1.0),{prefix}.z)",
            f"radiance+=viewT*incident*phase*scatterWeight({prefix}.x,{prefix}.y,transmittance);",
            "viewT*=transmittance;",
            "lightTransmittance(p,toLight,distance,sigmaT)",
            "radiance+background*viewT",
            "if(density>0.0)",
        )
        for fragment in required:
            if fragment not in code: raise AssertionError(f"{name}: physical source contract changed: {fragment}")
        assert code.index("radiance+=viewT") < code.index("viewT*=transmittance;"), "Accumulate before advancing view attenuation"
        suffix = "u" if name == "wgsl" else ""
        for key, constant in (("viewSteps", "VIEW_STEPS"), ("lightSteps", "LIGHT_STEPS")):
            assert re.search(rf"{constant}(?::u32)?={model[key]}{suffix};", code), f"{name} step count differs from MODEL"
    for radius, low, high in zip(model["densityRadius"], model["boundsMin"], model["boundsMax"]):
        assert radius > 0 and low <= -radius and radius <= high, "Density support must fit its integration bounds"
    light_distance_sq = sum(max(low - p, 0, p - high) ** 2
                            for p, low, high in zip(model["lightPosition"], model["boundsMin"], model["boundsMax"]))
    assert light_distance_sq > 0.0001, "Point light must stay clear of the inverse-square singularity clamp"


def validate(source: str) -> dict:
    functions = {language: {name: ShaderFunction(source, name, language)
                            for name in ("segmentT", "scatterWeight", "phaseHG")}
                 for language in ("WGSL", "GLSL")}
    model_match = re.search(r"\bconst\s+MODEL\s*=\s*(\{[\s\S]*?\})\s*;", source)
    if not model_match: raise ValueError("Missing shared MODEL JSON")
    model = json.loads(model_match[1])
    sigma_a, sigma_s, asymmetry = model["sigmaA"], model["sigmaS"], model["g"]
    assert sigma_a >= 0 and sigma_s > 0 and abs(asymmetry) < 1
    check_source_contract(source, model)
    report = {"coefficients": {"sigma_a": sigma_a, "sigma_s": sigma_s, "g": asymmetry},
              "source_contract": "Segment recurrence, HG propagation direction, step counts, finite support, and point-light separation pass.",
              "languages": {}}
    for language, helpers in functions.items():
        transmission, weight, hg = (helpers[name] for name in ("segmentT", "scatterWeight", "phaseHG"))
        slab_error = 0.0
        for a, s in ((sigma_a, sigma_s), (0.0, sigma_s), (sigma_a, 0.0), (0.0, 0.0)):
            for rho, distance in ((0.0, 3.0), (0.4, 0.0), (0.4, 3.0), (1.7, 9.0), (10.0, 1000.0)):
                expected_t = math.exp(-(a + s) * rho * distance)
                expected_l = 1.7 * 0.08 * (s / (a + s) if a + s > 0 else 0) * (1 - expected_t)
                for steps in (1, 4, 16, 64, 256):
                    result_t, result_l = integrate(transmission, weight, a, s, distance, steps, lambda _: rho)
                    near(result_t, expected_t, name=f"{language} homogeneous transmittance")
                    near(result_l, expected_l, name=f"{language} homogeneous radiance")
                    assert 0 <= result_t <= 1 and result_l >= 0
                    slab_error = max(slab_error, abs(result_t - expected_t), abs(result_l - expected_l))
        for mu in (-1, -0.3, 0, 0.7, 1): near(hg(mu, 0), 1 / (4 * math.pi), 1e-9, "isotropic phase")
        normalization_error = 0.0
        for g in (-0.7, asymmetry, 0.7):
            integral = 2 * math.pi * simpson(lambda mu: hg(mu, g), -1, 1)
            near(integral, 1.0, 1e-7, f"{language} HG normalization")
            mean = 2 * math.pi * simpson(lambda mu: mu * hg(mu, g), -1, 1)
            near(mean, g, 1e-7, f"{language} HG propagation-direction mean cosine")
            normalization_error = max(normalization_error, abs(integral - 1))
        if asymmetry > 0:
            assert hg(1, asymmetry) > hg(-1, asymmetry), "Positive g must favor forward propagation"
        elif asymmetry < 0:
            assert hg(-1, asymmetry) > hg(1, asymmetry), "Negative g must favor backward propagation"
        else:
            near(hg(1, 0), hg(-1, 0), name="isotropic direction symmetry")
        distance = 3.0
        def density(x):
            u = x / distance
            return 0.15 + 0.35 * u * u + 0.45 * math.exp(-((u - 0.4) / 0.18) ** 2)
        optical_depth_integral = distance * (0.15 + 0.35 / 3 + 0.45 * 0.18 * math.sqrt(math.pi) / 2
                                             * (math.erf(0.6 / 0.18) - math.erf(-0.4 / 0.18)))
        exact_t = math.exp(-(sigma_a + sigma_s) * optical_depth_integral)
        errors = []
        for steps in (8, 16, 32, 64, 128):
            actual_t, actual_l = integrate(transmission, weight, sigma_a, sigma_s, distance, steps, density)
            exact_l = 1.7 * 0.08 * sigma_s / (sigma_a + sigma_s) * (1 - exact_t)
            errors.append(abs(actual_t - exact_t))
            near(actual_l, 1.7 * 0.08 * sigma_s / (sigma_a + sigma_s) * (1 - actual_t), name="telescoping segment radiance")
        assert all(new < old for old, new in zip(errors, errors[1:])), "Heterogeneous midpoint integration must converge"
        assert errors[3] < 5e-5, f"64-step reference error too high: {errors[3]}"
        report["languages"][language] = {"max_homogeneous_error": slab_error, "HG_normalization_error": normalization_error,
                                             "heterogeneous_transmittance_errors_8_to_128_steps": errors}
    report["scope"] = "CPU scalar shader equations and quadrature; GPU pixel agreement is not established. The renderer omits multiple scattering."
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "assets/js/render-study.js")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = validate(args.source.read_text(encoding="utf-8"))
    if args.json: print(json.dumps(report, indent=2))
    else:
        print("Volume study: WGSL and GLSL scalar equations pass analytical checks.")
        for language, result in report["languages"].items():
            print(f"  {language}: homogeneous error {result['max_homogeneous_error']:.3g}; HG normalization error {result['HG_normalization_error']:.3g}; "
                  f"64-step heterogeneous transmittance error {result['heterogeneous_transmittance_errors_8_to_128_steps'][3]:.3g}")
        print(report["source_contract"])
        print(report["scope"])


if __name__ == "__main__": main()
