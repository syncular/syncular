const observationSources = new WeakMap<object, object>();

/**
 * Preserve supervisor observation across a facade without transferring
 * transport ownership or exposing the source client. Binding packages use
 * this when they normalize a client into another object identity.
 */
export function linkRealtimeSupervisorObservation<Target extends object>(
  target: Target,
  source: object,
): Target {
  if (target !== source) observationSources.set(target, source);
  return target;
}

/** @internal Resolve one facade hop for the supervisor attachment lookup. */
export function realtimeSupervisorObservationSource(
  target: object,
): object | undefined {
  return observationSources.get(target);
}
