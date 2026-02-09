import { SerializePlugin } from '@syncular/core';

function isBufferLike(value: object): value is { buffer: unknown } {
  return 'buffer' in value;
}

function serializeForConformance(parameter: unknown): unknown {
  if (
    parameter === null ||
    parameter === undefined ||
    typeof parameter === 'string' ||
    typeof parameter === 'number' ||
    typeof parameter === 'bigint' ||
    typeof parameter === 'boolean'
  ) {
    return parameter;
  }

  if (parameter instanceof Date) {
    return parameter.toISOString();
  }

  if (typeof parameter === 'object' && isBufferLike(parameter)) {
    return parameter;
  }

  try {
    return JSON.stringify(parameter);
  } catch {
    return parameter;
  }
}

export function createConformanceSerializePlugin(): SerializePlugin {
  return new SerializePlugin({ serializer: serializeForConformance });
}
