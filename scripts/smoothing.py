"""
smoothing.py — Catmull-Rom interpolation for corridor geometries.

Given a sparse polyline of control points (the hand-authored shape of a
corridor), produce a dense, curve-continuous polyline suitable for rendering.
The output is deterministic for a given input — no randomness, no rounding
beyond what the caller applies.

Reference: https://en.wikipedia.org/wiki/Centripetal_Catmull%E2%80%93Rom_spline

Implementation: standard non-uniform Catmull-Rom with tension parameter alpha
(the spline parameter, not the tension knob). alpha=0.5 yields the centripetal
variant, which avoids cusps and self-intersections — the practical default for
cartographic line work. Endpoints are duplicated as phantom anchors so the
curve passes through the first and last control points.
"""

from __future__ import annotations

import math


def catmull_rom_smooth(
    control_points: list[list[float]],
    sub_points_per_segment: int = 50,
    alpha: float = 0.5,
) -> list[list[float]]:
    """
    Interpolate a Catmull-Rom spline through `control_points`.

    Args:
      control_points: list of [lng, lat] pairs. At least 2 are required; if
        exactly 2 are provided the function returns the linear interpolation
        between them at the requested density.
      sub_points_per_segment: number of generated points between each adjacent
        pair of control points (exclusive of the start, inclusive of the end).
        Default 50 yields a smooth curve that reads as continuous at typical
        valley-extent zoom levels.
      alpha: spline parameter. 0.0 = uniform, 0.5 = centripetal (recommended),
        1.0 = chordal. Default 0.5.

    Returns:
      A list of [lng, lat] pairs starting at control_points[0] and ending at
      control_points[-1]. Length is 1 + sub_points_per_segment * (n - 1) where
      n is the number of control points.
    """
    n = len(control_points)
    if n < 2:
        raise ValueError("catmull_rom_smooth requires at least 2 control points")
    if n == 2:
        # Degenerate input: linearly interpolate the chord.
        x0, y0 = control_points[0]
        x1, y1 = control_points[1]
        out: list[list[float]] = [[x0, y0]]
        for i in range(1, sub_points_per_segment + 1):
            t = i / sub_points_per_segment
            out.append([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
        return out

    # Phantom endpoints — reflect the first and last interior segments outward
    # so the spline passes through the original endpoints.
    p_first = [
        2 * control_points[0][0] - control_points[1][0],
        2 * control_points[0][1] - control_points[1][1],
    ]
    p_last = [
        2 * control_points[-1][0] - control_points[-2][0],
        2 * control_points[-1][1] - control_points[-2][1],
    ]
    pts = [p_first] + list(control_points) + [p_last]

    out: list[list[float]] = [list(control_points[0])]
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for j in range(1, sub_points_per_segment + 1):
            t = j / sub_points_per_segment
            out.append(_catmull_rom_point(p0, p1, p2, p3, t, alpha))
    return out


def _catmull_rom_point(
    p0: list[float],
    p1: list[float],
    p2: list[float],
    p3: list[float],
    t: float,
    alpha: float,
) -> list[float]:
    """Evaluate a Catmull-Rom segment between p1 and p2 at parameter t in [0,1]."""
    # Knot vector spacing — alpha=0.5 (centripetal) uses sqrt of chord length.
    t0 = 0.0
    t1 = t0 + _knot_distance(p0, p1, alpha)
    t2 = t1 + _knot_distance(p1, p2, alpha)
    t3 = t2 + _knot_distance(p2, p3, alpha)

    # Guard against coincident control points (would divide by zero).
    if t1 == t0 or t2 == t1 or t3 == t2:
        # Fall back to linear interpolation between p1 and p2.
        return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]

    # Map the local parameter t (in [0,1] over segment p1→p2) to the knot space.
    tt = t1 + (t2 - t1) * t

    a1 = _lerp(p0, p1, (tt - t0) / (t1 - t0))
    a2 = _lerp(p1, p2, (tt - t1) / (t2 - t1))
    a3 = _lerp(p2, p3, (tt - t2) / (t3 - t2))

    b1 = _lerp(a1, a2, (tt - t0) / (t2 - t0))
    b2 = _lerp(a2, a3, (tt - t1) / (t3 - t1))

    return _lerp(b1, b2, (tt - t1) / (t2 - t1))


def _knot_distance(a: list[float], b: list[float], alpha: float) -> float:
    """|b - a|^alpha — the spacing between adjacent knots in the knot vector."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    d2 = dx * dx + dy * dy
    if d2 == 0.0:
        return 0.0
    return math.pow(d2, 0.5 * alpha)


def _lerp(a: list[float], b: list[float], t: float) -> list[float]:
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]


def haversine_length_meters(points: list[list[float]]) -> float:
    """
    Sum Haversine distances along a polyline of [lng, lat] pairs and return
    total length in meters. Used to compute corridor lengths for Dijkstra.
    """
    if len(points) < 2:
        return 0.0
    R = 6_371_000.0
    total = 0.0
    for i in range(1, len(points)):
        lng1, lat1 = points[i - 1]
        lng2, lat2 = points[i]
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlam = math.radians(lng2 - lng1)
        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
        )
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        total += R * c
    return total
