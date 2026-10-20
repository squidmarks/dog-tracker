import type { Db } from "./db.js";
import type { SendResult } from "./collar.js";
import { isCharging, type Monitor } from "./rules.js";

/**
 * Beeps a dog's collar while it is outside its zone. Each beep is one text message to that collar (whose notification
 * settings play a tune, and repeat it for the Nag Timeout). So the rhythm is simply: one message every `beepIntervalS`.
 * It starts as soon as the exit is confirmed, and stops when the dog is back, when walking mode is on, or after the cap.
 */
export class Beeper {
  private state = new Map<string, { since: number; lastBeepAt: number; beeps: number }>();
  private running = false;

  constructor(
    private db: Db, private monitor: Monitor,
    private send: (node: string) => Promise<SendResult>,
    private log: (line: string) => void = console.log,
  ) {}

  async tick(now = Math.floor(Date.now() / 1000)) {
    if (this.running) return;                       // a slow send mustn't pile ticks up
    this.running = true;
    try {
      const settings = await this.db.settings();
      const walking = (await this.db.snooze(now)) != null;
      for (const dog of await this.db.dogs()) {
        const st = this.state.get(dog.id);
        const wanted = dog.beep === true && !!dog.tracker && !isCharging(dog) && !walking && this.monitor.isOutside(dog.id);
        if (!wanted) {
          if (st) { this.state.delete(dog.id); this.log(`[beeper] ${dog.name}: stopped after ${st.beeps} beep${st.beeps === 1 ? "" : "s"}`); }
          continue;
        }
        const s = st ?? { since: now, lastBeepAt: 0, beeps: 0 };
        this.state.set(dog.id, s);
        if (now - s.since > settings.beepMaxMinutes * 60) continue;        // reached the cap: quiet until it comes back
        if (now - s.lastBeepAt < settings.beepIntervalS) continue;
        s.lastBeepAt = now; s.beeps++;
        // The tag's radio is asleep between listens, so a first try often goes unheard: retry quickly until it acks.
        let r = await this.send(dog.tracker!), tries = 1;
        while (r.sent && !r.acked && tries < 3) { r = await this.send(dog.tracker!); tries++; }
        this.log(`[beeper] ${dog.name}: beep ${s.beeps} ${r.sent ? (r.acked ? `(acknowledged${tries > 1 ? `, try ${tries}` : ""})` : `(no receipt after ${tries})`) : `FAILED: ${r.error}`}`);
      }
    } finally { this.running = false; }
  }

  /** A test beep right now, whatever the dog is doing. */
  async test(dogId: string): Promise<SendResult> {
    const dog = await this.db.dog(dogId);
    if (!dog) return { sent: false, acked: false, error: "unknown dog" };
    if (!dog.tracker) return { sent: false, acked: false, error: "this dog has no tracker linked" };
    return this.send(dog.tracker);
  }
}
