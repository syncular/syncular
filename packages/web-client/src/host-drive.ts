/**
 * §8.4: milliseconds a host loop holds a queued drive, and a host drive holds
 * the round that confirms idle, so the claims and writes of one burst ride in
 * one round. A view registers its queries over one React commit and its
 * effects, a few to a few dozen milliseconds apart; 50 ms gathers them and
 * stays under the 100 ms a person notices.
 */
export const HOST_COALESCE_MS = 50;

/**
 * §8.4: marks a drive of a host loop (the scheduler, the worker `autoSync`
 * loop, the realtime supervisor). Such a drive ends without a round on a
 * replica with nothing to exchange and holds its idle-confirming round for
 * {@link HOST_COALESCE_MS}. The package entry does not export it, so an app's
 * `syncUntilIdle()` always sends a request.
 */
export const HOST_DRIVE: unique symbol = Symbol('syncular.hostDrive');
