import type { RequiredTransitionConstraint } from "@dnb-crate/domain";

export class PlanningConstraintError extends Error {
  constructor(message: string) {
    super(`CONSTRAINT_INVALID:${message}`);
    this.name = "PlanningConstraintError";
  }
}

export type CompiledPlanningConstraints = {
  requiredTransitions: RequiredTransitionConstraint[];
  successorOf: Map<string, RequiredTransitionConstraint>;
  preferredSuccessorOf: Map<string, RequiredTransitionConstraint>;
  reservedIncoming: Set<string>;
  lockedTrackIds: Set<string>;
  recipeIdForPair(outgoingTrackId: string, incomingTrackId: string): string | undefined;
  reuseForPair(outgoingTrackId: string, incomingTrackId: string): "pair" | "recipe" | undefined;
  constraintFor(
    outgoingTrackId: string,
    incomingTrackId: string,
  ): RequiredTransitionConstraint | undefined;
};

function pairKey(outgoingTrackId: string, incomingTrackId: string): string {
  return `${outgoingTrackId}->${incomingTrackId}`;
}

function hasCycle(successor: Map<string, string>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }
    visiting.add(node);
    const next = successor.get(node);
    if (next && visit(next)) {
      return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of successor.keys()) {
    if (visit(node)) {
      return true;
    }
  }
  return false;
}

export function compilePlanningConstraints(
  rows: RequiredTransitionConstraint[] | undefined,
  bounds: { startTrackId?: string; endTrackId?: string } = {},
): CompiledPlanningConstraints {
  const requiredTransitions = rows ?? [];
  const successorOf = new Map<string, RequiredTransitionConstraint>();
  const preferredSuccessorOf = new Map<string, RequiredTransitionConstraint>();
  const requiredGraph = new Map<string, string>();
  const predecessorOf = new Map<string, string>();
  const declarations = new Map<string, string>();

  for (const row of requiredTransitions) {
    const key = pairKey(row.outgoingTrackId, row.incomingTrackId);
    const declaration = JSON.stringify([
      row.strength,
      row.reuse,
      row.recipeId ?? null,
      row.allowQualityException ?? false,
    ]);
    if (declarations.has(key) && declarations.get(key) !== declaration) {
      throw new PlanningConstraintError(`Conflicting declarations for ${key}`);
    }
    declarations.set(key, declaration);
    if (row.outgoingTrackId === row.incomingTrackId) {
      throw new PlanningConstraintError("A required transition cannot map a track to itself");
    }
    if (row.strength === "required") {
      const predecessor = predecessorOf.get(row.incomingTrackId);
      if (predecessor && predecessor !== row.outgoingTrackId) {
        throw new PlanningConstraintError(
          `Track ${row.incomingTrackId} has two required predecessors`,
        );
      }
      predecessorOf.set(row.incomingTrackId, row.outgoingTrackId);
      const existing = successorOf.get(row.outgoingTrackId);
      if (existing && existing.incomingTrackId !== row.incomingTrackId) {
        throw new PlanningConstraintError(
          `Track ${row.outgoingTrackId} has two required successors`,
        );
      }
      successorOf.set(row.outgoingTrackId, row);
      requiredGraph.set(row.outgoingTrackId, row.incomingTrackId);
    } else {
      const existing = preferredSuccessorOf.get(row.outgoingTrackId);
      if (existing && existing.incomingTrackId !== row.incomingTrackId) {
        continue;
      }
      preferredSuccessorOf.set(row.outgoingTrackId, row);
    }
  }

  if (hasCycle(requiredGraph)) {
    throw new PlanningConstraintError("Required transitions form a cycle");
  }

  for (const row of requiredTransitions) {
    if (row.strength !== "required") {
      continue;
    }
    if (bounds.startTrackId && row.incomingTrackId === bounds.startTrackId) {
      throw new PlanningConstraintError("A required incoming track cannot be the start track");
    }
    if (bounds.endTrackId && row.outgoingTrackId === bounds.endTrackId) {
      throw new PlanningConstraintError("A required outgoing track cannot be the end track");
    }
  }

  for (const [outgoing, preferred] of [...preferredSuccessorOf.entries()]) {
    const required = successorOf.get(outgoing);
    if (required && required.incomingTrackId !== preferred.incomingTrackId) {
      preferredSuccessorOf.delete(outgoing);
    }
  }

  const reservedIncoming = new Set<string>();
  const lockedTrackIds = new Set<string>();
  for (const row of requiredTransitions) {
    if (row.strength === "required") {
      lockedTrackIds.add(row.outgoingTrackId);
      lockedTrackIds.add(row.incomingTrackId);
      reservedIncoming.add(row.incomingTrackId);
    }
  }

  const byPair = new Map(
    requiredTransitions.map((row) => [pairKey(row.outgoingTrackId, row.incomingTrackId), row]),
  );

  return {
    requiredTransitions,
    successorOf,
    preferredSuccessorOf,
    reservedIncoming,
    lockedTrackIds,
    recipeIdForPair(outgoingTrackId, incomingTrackId) {
      const row = byPair.get(pairKey(outgoingTrackId, incomingTrackId));
      return row?.reuse === "recipe" ? row.recipeId : undefined;
    },
    reuseForPair(outgoingTrackId, incomingTrackId) {
      return byPair.get(pairKey(outgoingTrackId, incomingTrackId))?.reuse;
    },
    constraintFor(outgoingTrackId, incomingTrackId) {
      return byPair.get(pairKey(outgoingTrackId, incomingTrackId));
    },
  };
}
