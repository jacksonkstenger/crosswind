"""Checks for the statistics behind the alert detectors. Run: python tests/test_stats.py"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline.stage_alerts import benjamini_hochberg, binom_sf, wilson_lower  # noqa: E402


def test_binomial_tail():
    assert binom_sf(0, 10, 0.3) == 1.0
    assert math.isclose(binom_sf(10, 10, 0.5), 0.5 ** 10)
    assert math.isclose(binom_sf(1, 10, 0.1), 1 - 0.9 ** 10)
    # complements: P[X >= c] + P[X <= c - 1] = 1
    n, p, c = 17, 0.23, 6
    lower = sum(math.comb(n, k) * p**k * (1 - p)**(n - k) for k in range(c))
    assert math.isclose(binom_sf(c, n, p) + lower, 1.0)


def test_wilson():
    # the Wilson interval is the set of p with (p_hat - p)^2 <= z^2 p (1 - p) / n; the bound is a root
    k, n, z = 18, 25, 1.959963984540054
    lb = wilson_lower(k, n, z)
    assert math.isclose((k / n - lb) ** 2, z * z * lb * (1 - lb) / n, rel_tol=1e-9)
    assert 0 < lb < k / n
    assert wilson_lower(0, 20, z) == 0.0 or abs(wilson_lower(0, 20, z)) < 1e-12


def test_benjamini_hochberg():
    p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216]
    rejected, adjusted = benjamini_hochberg(p, 0.05)
    # largest k with p_(k) <= k q / m is k = 2 (0.008 <= 0.010; 0.039 > 0.015)
    assert rejected == [True, True] + [False] * 8
    assert math.isclose(adjusted[0], 0.01) and math.isclose(adjusted[1], 0.04)
    assert all(a <= b + 1e-12 for a, b in zip(adjusted, adjusted[1:]))      # monotone in p
    shuffled = [p[i] for i in (3, 0, 9, 1, 5, 2, 8, 4, 7, 6)]
    assert benjamini_hochberg(shuffled, 0.05)[0] == [False, True, False, True] + [False] * 6


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok ", name)
