export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RateLimiter {
  private nextAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly clock: Clock = systemClock,
  ) {}

  async sleep(ms: number): Promise<void> {
    await this.clock.sleep(ms);
  }

  async wait(): Promise<void> {
    const now = this.clock.now();
    const delay = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.minIntervalMs;
    if (delay > 0) {
      await this.clock.sleep(delay);
    }
  }
}
