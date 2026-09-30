/** Minimal injectable scheduling boundary for lease and intervention lifecycle work. */
export interface InterventionScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemInterventionScheduler: InterventionScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Deterministic scheduler for lifecycle tests; it never uses real elapsed time. */
export class ManualInterventionScheduler implements InterventionScheduler {
  private time: number;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();

  constructor(initialTime = 0) {
    this.time = initialTime;
  }

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.time + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advanceBy(durationMs: number): void {
    this.time += durationMs;
    for (;;) {
      const ready = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= this.time)
        .sort(([left], [right]) => left - right)
        .at(0);
      if (!ready) return;
      this.tasks.delete(ready[0]);
      ready[1].callback();
    }
  }

  get pendingTaskCount(): number {
    return this.tasks.size;
  }
}
