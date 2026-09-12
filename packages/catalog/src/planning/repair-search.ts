/** Bounded search over whole chain units. The caller validates the resolved audible timeline. */
export function repairSequence(input: {
  initial: string[];
  units: string[][];
  required: Set<string>;
  start?: string;
  end?: string;
  minDurationMs: number;
  maxDurationMs: number;
  evaluate(ids: string[]): number | string | null;
  maxEvaluations?: number;
  optionalLimit?: number;
  rankOptional?(unit: string[], ids: string[]): number;
  musicalScore?(ids: string[]): number;
  compatible?(leftId: string, rightId: string): boolean;
}) {
  const limit = input.maxEvaluations ?? 800;
  const optionalLimit = input.optionalLimit ?? 12;
  let evaluations = 0;
  let invalid = 0;
  const rejectionCounts: Record<string, number> = {};
  const reject = (reason: string) => {
    invalid++;
    rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    return null;
  };
  const seen = new Set<string>();
  type State = {
    ids: string[];
    duration: number;
    missing: number;
    distance: number;
    musical: number;
  };
  const compare = (a: State, b: State) =>
    a.missing - b.missing ||
    a.distance - b.distance ||
    b.musical - a.musical ||
    a.ids.join("|").localeCompare(b.ids.join("|"));
  const inspect = (ids: string[]): State | null => {
    const key = ids.join("|");
    if (seen.has(key) || evaluations >= limit) return null;
    seen.add(key);
    evaluations++;
    if (
      new Set(ids).size !== ids.length ||
      (input.start && ids[0] !== input.start) ||
      (input.end && ids.at(-1) !== input.end) ||
      input.units.some(
        (unit) =>
          unit.length > 1 &&
          unit.some((id) => ids.includes(id)) &&
          !unit.every((id, offset) => ids[ids.indexOf(unit[0]!) + offset] === id),
      )
    ) {
      return reject("CHAIN_OR_BOUNDARY");
    }
    const duration = input.evaluate(ids);
    if (typeof duration !== "number") return reject(duration ?? "INVALID_TIMELINE");
    return {
      ids,
      duration,
      missing: [...input.required].filter((id) => !ids.includes(id)).length,
      distance: Math.max(input.minDurationMs - duration, duration - input.maxDurationMs, 0),
      musical: input.musicalScore?.(ids) ?? 0,
    };
  };
  const neighborsOk = (left: string | undefined, right: string | undefined) => {
    if (!left || !right || !input.compatible) return true;
    return input.compatible(left, right);
  };
  const canPlace = (unit: string[], ids: string[]) => {
    const firstPosition = input.start ? 1 : 0;
    const lastPosition = ids.length - (input.end ? 1 : 0);
    for (let pos = firstPosition; pos <= lastPosition; pos++) {
      if (neighborsOk(ids[pos - 1], unit[0]) && neighborsOk(unit.at(-1), ids[pos])) return true;
    }
    return false;
  };
  const hasBridge = (ids: string[], missingUnit: string[]) => {
    if (canPlace(missingUnit, ids)) return true;
    if (!input.compatible) return true;
    return input.units
      .filter((unit) => !unit.some((id) => input.required.has(id)))
      .some(
        (opt) =>
          ids.some((id) => input.compatible!(id, opt[0]!)) &&
          input.compatible!(opt.at(-1)!, missingUnit[0]!),
      );
  };
  const rankOptionals = (units: string[][], ids: string[]) =>
    [...units].sort(
      (a, b) =>
        (input.rankOptional?.(b, ids) ?? 0) - (input.rankOptional?.(a, ids) ?? 0) ||
        a.join("|").localeCompare(b.join("|")),
    );
  // Remove incomplete chains as units before trying all legal insertion positions.
  let base = [...input.initial];
  for (const unit of input.units.filter((unit) => unit.length > 1)) {
    if (!unit.every((id, offset) => base[base.indexOf(unit[0]!) + offset] === id))
      base = base.filter((id) => !unit.includes(id));
  }
  const first = inspect(base);
  let best = first;
  let frontier = first ? [first] : [];
  const ready = (state: State) => state.missing === 0 && state.distance === 0;
  const missingAtBase = input.units.filter(
    (unit) =>
      unit.some((id) => input.required.has(id)) && !unit.every((id) => base.includes(id)),
  );
  let harmonicGap = false;
  if (
    input.compatible &&
    missingAtBase.length > 0 &&
    !missingAtBase.every((unit) => hasBridge(base, unit))
  ) {
    harmonicGap = true;
    frontier = [];
  }
  for (
    let round = 0;
    round < 8 && frontier.length && evaluations < limit && !(best && ready(best));
    round++
  ) {
    const next: State[] = [];
    const offer = (ids: string[]) => {
      const state = inspect(ids);
      if (!state) return;
      next.push(state);
      if (!best || compare(state, best) < 0) best = state;
    };
    for (const state of frontier) {
      const stateLimit = Math.min(limit, evaluations + 200);
      const absent = input.units.filter((unit) => unit.every((id) => !state.ids.includes(id)));
      const missingUnits = absent.filter((unit) => unit.some((id) => input.required.has(id)));
      const optional = rankOptionals(
        absent.filter((unit) => !unit.some((id) => input.required.has(id))),
        state.ids,
      ).slice(0, optionalLimit);
      const firstPosition = input.start ? 1 : 0;
      const lastPosition = state.ids.length - (input.end ? 1 : 0);
      // Replacing a short optional span can free both harmonic/artist boundaries at once.
      // Required material is never removed to make room for another required chain.
      for (const unit of missingUnits) {
        for (let count = 0; count <= 3 && evaluations < stateLimit; count++) {
          for (
            let pos = firstPosition;
            pos + count <= lastPosition && evaluations < stateLimit;
            pos++
          ) {
            if (state.ids.slice(pos, pos + count).some((id) => input.required.has(id))) continue;
            offer([...state.ids.slice(0, pos), ...unit, ...state.ids.slice(pos + count)]);
            if (best && ready(best)) break;
          }
          if (best && ready(best)) break;
        }
        if (best && ready(best)) break;
      }
      if (best && ready(best)) break;
      // Finish optional offers for this state so musical ranking can choose among ready repairs.
      const optionalWork = missingUnits.length ? missingUnits : optional;
      for (const unit of optionalWork) {
        for (let pos = firstPosition; pos <= lastPosition && evaluations < stateLimit; pos++) {
          offer([...state.ids.slice(0, pos), ...unit, ...state.ids.slice(pos)]);
        }
      }
      if (best && ready(best)) break;
      // Removing/replacing an optional track may open a blocked chain boundary.
      for (let pos = firstPosition; pos < state.ids.length && evaluations < stateLimit; pos++) {
        const id = state.ids[pos]!;
        if (input.required.has(id) || id === input.end) continue;
        const without = state.ids.filter((_, index) => index !== pos);
        offer(without);
        for (const unit of [...missingUnits, ...optional]) {
          offer([...without.slice(0, pos), ...unit, ...without.slice(pos)]);
          if (evaluations >= stateLimit) break;
        }
        if (evaluations >= stateLimit) break;
      }
      if (best && ready(best)) break;
    }
    frontier = next.sort(compare).slice(0, 4);
  }
  return {
    ids: best?.ids ?? input.initial,
    diagnostics: {
      evaluations,
      rejectionCounts,
      invalid,
      limit,
      status:
        best && ready(best)
          ? "ready"
          : harmonicGap
            ? "harmonic-gap"
            : evaluations >= limit
              ? "budget-exhausted"
              : "no-improvement",
      missingRequired: best?.missing ?? input.required.size,
      durationDistanceMs: best?.distance ?? null,
      musicalScore: best?.musical ?? null,
    },
  };
}
