import {
  configureSyncTelemetry,
  getSyncTelemetry,
  type SyncTelemetry,
} from '@syncular/core';

const noopSpan = {
  setAttribute() {},
  setAttributes() {},
  setStatus() {},
};

const silentTelemetry: SyncTelemetry = {
  log() {},
  tracer: {
    startSpan(_options, callback) {
      return callback(noopSpan);
    },
  },
  metrics: {
    count() {},
    gauge() {},
    distribution() {},
  },
  captureException() {},
};

export function installSilentSyncTelemetry(): () => void {
  const previousTelemetry = getSyncTelemetry();
  configureSyncTelemetry(silentTelemetry);
  return () => {
    configureSyncTelemetry(previousTelemetry);
  };
}
