import { totalmem } from 'os'

/* One engine process peaks at a few GB (weights + the whole song on the
   device), so two at once needs real headroom: below 16GB of RAM a second
   concurrent split is what gets the pair killed, which looks like a random
   failure on the second song. Machines with less run one at a time and the
   rest queue. Lives apart from pipeline.ts so key detection can share the
   slots without importing electron. */
const MAX_CONCURRENT_SEPARATIONS = totalmem() >= 16 * 1024 ** 3 ? 2 : 1
let activeSeparations = 0
const separationWaiters: Array<() => void> = []

export function acquireSeparation(): Promise<() => void> {
  if (activeSeparations < MAX_CONCURRENT_SEPARATIONS) {
    activeSeparations++
    return Promise.resolve(releaseSeparation)
  }
  return new Promise((resolve) => {
    separationWaiters.push(() => {
      activeSeparations++
      resolve(releaseSeparation)
    })
  })
}

function releaseSeparation(): void {
  activeSeparations--
  separationWaiters.shift()?.()
}
