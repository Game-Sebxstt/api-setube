export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency debe ser ≥ 1');
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

export async function mapLimit<I, O>(items: readonly I[], concurrency: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}
