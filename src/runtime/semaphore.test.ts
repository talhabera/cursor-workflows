import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("never lets more than max run at once", async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let max = 0;
    const tasks = Array.from({ length: 8 }, async () => {
      await sem.acquire();
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      sem.release();
    });
    await Promise.all(tasks);
    expect(max).toBeLessThanOrEqual(2);
  });
});
