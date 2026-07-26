import type { CanonicalReadinessResult, ReadinessCondition } from "./conditions.js";
import type { ReadinessSubject } from "./subjects.js";

export type ReadinessTransitionChange =
  | {
      kind: "ready";
      before: boolean;
      after: boolean;
    }
  | {
      kind: "producer";
      before: string;
      after: string;
    }
  | {
      kind: "subject";
      change: "added" | "removed" | "replaced";
      ref: string;
      before?: ReadinessSubject;
      after?: ReadinessSubject;
    }
  | {
      kind: "condition";
      change: "added" | "removed" | "changed";
      subjectRef: string;
      type: string;
      before?: ReadinessCondition;
      after?: ReadinessCondition;
    };

type ComparableReadinessResult = Pick<CanonicalReadinessResult, "ready" | "conditions"> &
  Partial<Pick<CanonicalReadinessResult, "identity">>;

function stableStringArray(values: string[] | undefined): string[] | undefined {
  return values?.toSorted();
}

function conditionsEqual(left: ReadinessCondition, right: ReadinessCondition): boolean {
  return (
    left.status === right.status &&
    left.requirement === right.requirement &&
    left.reason === right.reason &&
    left.message === right.message &&
    JSON.stringify(stableStringArray(left.relatedSubjectRefs)) ===
      JSON.stringify(stableStringArray(right.relatedSubjectRefs))
  );
}

function subjectsEqual(left: ReadinessSubject, right: ReadinessSubject): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.generation === right.generation &&
    left.parentRef === right.parentRef
  );
}

function conditionKey(condition: ReadinessCondition): string {
  return JSON.stringify([condition.subjectRef ?? "legacy", condition.type]);
}

export function diffReadinessResults(
  before: ComparableReadinessResult,
  after: ComparableReadinessResult,
): ReadinessTransitionChange[] {
  const changes: ReadinessTransitionChange[] = [];
  if (before.ready !== after.ready) {
    changes.push({ kind: "ready", before: before.ready, after: after.ready });
  }
  if (
    before.identity?.producerRef &&
    after.identity?.producerRef &&
    before.identity.producerRef !== after.identity.producerRef
  ) {
    changes.push({
      kind: "producer",
      before: before.identity.producerRef,
      after: after.identity.producerRef,
    });
  }

  const beforeSubjects = new Map(
    before.identity?.subjects.map((subject) => [subject.ref, subject]),
  );
  const afterSubjects = new Map(after.identity?.subjects.map((subject) => [subject.ref, subject]));
  for (const ref of [...new Set([...beforeSubjects.keys(), ...afterSubjects.keys()])].toSorted()) {
    const previous = beforeSubjects.get(ref);
    const current = afterSubjects.get(ref);
    if (!previous && current) {
      changes.push({ kind: "subject", change: "added", ref, after: current });
    } else if (previous && !current) {
      changes.push({ kind: "subject", change: "removed", ref, before: previous });
    } else if (previous && current && !subjectsEqual(previous, current)) {
      changes.push({
        kind: "subject",
        change: "replaced",
        ref,
        before: previous,
        after: current,
      });
    }
  }

  const beforeConditions = new Map(
    before.conditions.map((condition) => [conditionKey(condition), condition]),
  );
  const afterConditions = new Map(
    after.conditions.map((condition) => [conditionKey(condition), condition]),
  );
  for (const key of [
    ...new Set([...beforeConditions.keys(), ...afterConditions.keys()]),
  ].toSorted()) {
    const previous = beforeConditions.get(key);
    const current = afterConditions.get(key);
    const basis = current ?? previous;
    if (!basis) {
      continue;
    }
    const shared = { subjectRef: basis.subjectRef ?? "legacy", type: basis.type };
    if (!previous && current) {
      changes.push({ kind: "condition", change: "added", ...shared, after: current });
    } else if (previous && !current) {
      changes.push({ kind: "condition", change: "removed", ...shared, before: previous });
    } else if (previous && current && !conditionsEqual(previous, current)) {
      changes.push({
        kind: "condition",
        change: "changed",
        ...shared,
        before: previous,
        after: current,
      });
    }
  }
  return changes;
}
