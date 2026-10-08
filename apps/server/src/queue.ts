/** Run async jobs strictly one after another (a node's "touch" must land before its position, etc.). */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return (job: () => Promise<unknown> | unknown) => {
    tail = tail.then(job).catch((e) => console.error("[queue]", e));
  };
}
