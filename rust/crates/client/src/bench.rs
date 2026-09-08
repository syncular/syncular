//! Opt-in, per-client timing for the private repository benchmark driver.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::thread::{self, ThreadId};
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Copy)]
pub(crate) enum Phase {
    RequestPrepare,
    RequestEncode,
    OutboxEncode,
    ResponseDecode,
    ResponseApply,
    CommitApply,
    RowDecode,
    RowWrite,
    ObservationPrepare,
    ObservationCommit,
    CursorPersist,
    OverlayRebuild,
    PendingReplay,
    BlobReconcile,
    BlobDownload,
    BlobValidate,
    BlobEncode,
    BlobCacheRead,
    BlobCacheInsert,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::RequestPrepare => "requestPrepare",
            Self::RequestEncode => "requestEncode",
            Self::OutboxEncode => "outboxEncode",
            Self::ResponseDecode => "responseDecode",
            Self::ResponseApply => "responseApply",
            Self::CommitApply => "commitApply",
            Self::RowDecode => "rowDecode",
            Self::RowWrite => "rowWrite",
            Self::ObservationPrepare => "observationPrepare",
            Self::ObservationCommit => "observationCommit",
            Self::CursorPersist => "cursorPersist",
            Self::OverlayRebuild => "overlayRebuild",
            Self::PendingReplay => "pendingReplay",
            Self::BlobReconcile => "blobReconcile",
            Self::BlobDownload => "blobDownload",
            Self::BlobValidate => "blobValidate",
            Self::BlobEncode => "blobEncode",
            Self::BlobCacheRead => "blobCacheRead",
            Self::BlobCacheInsert => "blobCacheInsert",
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    calls: u64,
    elapsed_ns: u64,
    thread_cpu_ns: u64,
    units: u64,
}

#[derive(Default)]
struct State {
    enabled: bool,
    generation: u64,
    measurements: BTreeMap<&'static str, Measurement>,
}

#[derive(Default)]
pub(crate) struct Recorder(Arc<Mutex<State>>);

impl Recorder {
    pub(crate) fn configure(&self, enabled: Option<bool>, reset: bool) -> Result<(), String> {
        if enabled == Some(true) {
            thread_cpu_ns()?;
        }
        let mut state = self.0.lock().expect("benchmark phase lock poisoned");
        if let Some(enabled) = enabled {
            state.enabled = enabled;
        }
        if enabled.is_some() || reset {
            state.generation += 1;
            state.measurements.clear();
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> Option<Value> {
        let state = self.0.lock().expect("benchmark phase lock poisoned");
        state.enabled.then(|| json!({
            "version": 1,
            "scope": "Per-client inclusive phases since enable/reset; nested phases overlap. CPU covers the calling thread, excluding transport I/O threads. Counts include failed calls. Units count attempted pending operations only.",
            "measurements": state.measurements,
        }))
    }

    pub(crate) fn start(&self, phase: Phase) -> Option<Guard> {
        let state = self.0.lock().expect("benchmark phase lock poisoned");
        state.enabled.then(|| Guard {
            state: self.0.clone(),
            generation: state.generation,
            phase,
            owner: thread::current().id(),
            started: Instant::now(),
            cpu_started: thread_cpu_ns().expect("benchmark thread CPU clock failed"),
            units: 0,
        })
    }
}

pub(crate) struct Guard {
    state: Arc<Mutex<State>>,
    generation: u64,
    phase: Phase,
    owner: ThreadId,
    started: Instant,
    cpu_started: u64,
    units: u64,
}

impl Guard {
    pub(crate) fn unit(&mut self) {
        self.units += 1;
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        assert_eq!(
            self.owner,
            thread::current().id(),
            "benchmark phase changed thread"
        );
        let elapsed_ns = u64::try_from(self.started.elapsed().as_nanos())
            .expect("benchmark phase duration overflow");
        let cpu_ns = thread_cpu_ns()
            .expect("benchmark thread CPU clock failed")
            .checked_sub(self.cpu_started)
            .expect("benchmark thread CPU clock regressed");
        let mut state = self.state.lock().expect("benchmark phase lock poisoned");
        if !state.enabled || state.generation != self.generation {
            return;
        }
        let measurement = state.measurements.entry(self.phase.name()).or_default();
        measurement.calls += 1;
        measurement.elapsed_ns += elapsed_ns;
        measurement.thread_cpu_ns += cpu_ns;
        measurement.units += self.units;
    }
}

fn thread_cpu_ns() -> Result<u64, String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // The clock writes one initialized timespec and retains no pointer.
        if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) } != 0 {
            return Err("Benchmark thread CPU clock is unavailable".into());
        }
        let seconds = u64::try_from(time.tv_sec).map_err(|_| "Invalid benchmark CPU seconds")?;
        let nanos = u64::try_from(time.tv_nsec).map_err(|_| "Invalid benchmark CPU nanoseconds")?;
        seconds
            .checked_mul(1_000_000_000)
            .and_then(|n| n.checked_add(nanos))
            .ok_or_else(|| "Benchmark CPU clock overflow".into())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Err("Benchmark thread CPU phases require Linux or macOS".into())
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn phases_are_opt_in_isolated_nested_and_reset_discards_open_spans() {
        let first = Recorder::default();
        let second = Recorder::default();
        assert!(first.start(Phase::PendingReplay).is_none());
        assert!(first.snapshot().is_none());
        first.configure(Some(true), false).unwrap();
        let outer = first.start(Phase::OverlayRebuild).unwrap();
        {
            let mut inner = first.start(Phase::PendingReplay).unwrap();
            for value in 0..100 {
                std::hint::black_box(value * value);
                inner.unit();
            }
        }
        drop(outer);
        let snapshot = first.snapshot().unwrap();
        assert_eq!(snapshot["measurements"]["pendingReplay"]["calls"], 1);
        assert_eq!(snapshot["measurements"]["pendingReplay"]["units"], 100);
        for key in ["elapsedNs", "threadCpuNs"] {
            assert!(
                snapshot["measurements"]["overlayRebuild"][key]
                    .as_u64()
                    .unwrap()
                    >= snapshot["measurements"]["pendingReplay"][key]
                        .as_u64()
                        .unwrap()
            );
        }
        assert!(second.snapshot().is_none());
        let old = first.start(Phase::PendingReplay).unwrap();
        first.configure(None, true).unwrap();
        drop(old);
        assert_eq!(first.snapshot().unwrap()["measurements"], json!({}));
        {
            let _error_scope = first.start(Phase::ResponseApply).unwrap();
            let failed = || -> Result<(), ()> { Err(()) };
            assert!(failed().is_err());
        }
        assert_eq!(
            first.snapshot().unwrap()["measurements"]["responseApply"]["calls"],
            1
        );
        first.configure(Some(false), false).unwrap();
        assert!(first.snapshot().is_none());
    }
}
