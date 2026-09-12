//! Ephemeral live sync work (SPEC §7.6), observable while the core is busy.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub attempt: u64,
    pub state: ProgressState,
    pub phase: ProgressPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_id: Option<String>,
    pub bytes_received: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    pub rows_processed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProgressState {
    Running,
    Complete,
    Failed,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProgressPhase {
    Request,
    Download,
    Import,
}

pub type SyncProgressListener = Arc<dyn Fn(&SyncProgress) + Send + Sync>;

struct Delivery {
    callback: SyncProgressListener,
    revision: Mutex<u64>,
}
impl Delivery {
    fn notify(&self, revision: u64, snapshot: &SyncProgress) {
        let mut delivered = self.revision.lock().expect("progress delivery lock");
        if revision <= *delivered {
            return;
        }
        *delivered = revision;
        // Serialize a late initial replay with updates from the owner thread.
        // The observer registry is unlocked, so callbacks can read/unsubscribe.
        let _ =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.callback)(snapshot)));
    }
}
#[derive(Default)]
struct Inner {
    snapshot: Option<SyncProgress>,
    listeners: BTreeMap<u64, Arc<Delivery>>,
    revision: u64,
    next_listener: u64,
}

#[derive(Clone, Default)]
pub struct ProgressObserver(Arc<Mutex<Inner>>);

/// Keep this guard alive to receive updates; dropping it unsubscribes.
pub struct ProgressSubscription {
    inner: Weak<Mutex<Inner>>,
    id: u64,
}
impl Drop for ProgressSubscription {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            inner
                .lock()
                .expect("progress lock")
                .listeners
                .remove(&self.id);
        }
    }
}
impl ProgressObserver {
    pub fn snapshot(&self) -> Option<SyncProgress> {
        self.0.lock().expect("progress lock").snapshot.clone()
    }
    pub fn subscribe(
        &self,
        listener: impl Fn(&SyncProgress) + Send + Sync + 'static,
    ) -> ProgressSubscription {
        let listener = Arc::new(Delivery {
            callback: Arc::new(listener),
            revision: Mutex::new(0),
        });
        let (id, revision, snapshot) = {
            let mut inner = self.0.lock().expect("progress lock");
            inner.next_listener += 1;
            let id = inner.next_listener;
            inner.listeners.insert(id, listener.clone());
            (id, inner.revision, inner.snapshot.clone())
        };
        if let Some(snapshot) = snapshot {
            listener.notify(revision, &snapshot);
        }
        ProgressSubscription {
            inner: Arc::downgrade(&self.0),
            id,
        }
    }
    pub(crate) fn start(&self) {
        let attempt = self.snapshot().map_or(1, |s| s.attempt + 1);
        self.emit(SyncProgress {
            attempt,
            state: ProgressState::Running,
            phase: ProgressPhase::Request,
            subscription_id: None,
            table: None,
            segment_id: None,
            bytes_received: 0,
            bytes_total: None,
            rows_processed: 0,
            rows_total: None,
            error_code: None,
        });
    }
    pub(crate) fn update(&self, update: impl FnOnce(&mut SyncProgress)) {
        if let Some(mut snapshot) = self.snapshot() {
            if snapshot.state != ProgressState::Running {
                return;
            }
            update(&mut snapshot);
            self.emit(snapshot);
        }
    }
    fn emit(&self, snapshot: SyncProgress) {
        let (revision, listeners) = {
            let mut inner = self.0.lock().expect("progress lock");
            inner.snapshot = Some(snapshot.clone());
            inner.revision += 1;
            (
                inner.revision,
                inner.listeners.values().cloned().collect::<Vec<_>>(),
            )
        };
        for listener in listeners {
            listener.notify(revision, &snapshot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observes_running_work_and_unsubscribes_without_affecting_sync() {
        let observer = ProgressObserver::default();
        observer.start();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let reader = observer.clone();
        let subscription = observer.subscribe(move |progress| {
            assert!(reader.snapshot().is_some()); // Callback holds no observer lock.
            captured.lock().unwrap().push(progress.clone());
        });
        let _broken = observer.subscribe(|_| panic!("observer failure"));
        observer.update(|p| {
            p.phase = ProgressPhase::Import;
            p.rows_processed = 1024;
        });
        assert_eq!(events.lock().unwrap().len(), 2);
        drop(subscription);
        observer.update(|p| {
            p.state = ProgressState::Failed;
            p.error_code = Some("sync.transport_failed".into());
        });
        assert_eq!(events.lock().unwrap().len(), 2);
        observer.start();
        let snapshot = observer.snapshot().unwrap();
        assert_eq!(snapshot.attempt, 2);
        assert_eq!(snapshot.rows_processed, 0);
        assert_eq!(snapshot.error_code, None);
    }
    #[test]
    fn late_subscription_replay_cannot_move_progress_backwards() {
        let observer = ProgressObserver::default();
        observer.start();
        let before = observer.snapshot().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let delivery = Delivery {
            callback: Arc::new(move |p| captured.lock().unwrap().push(p.rows_processed)),
            revision: Mutex::new(0),
        };
        let mut after = before.clone();
        after.rows_processed = 1024;
        delivery.notify(2, &after);
        delivery.notify(1, &before);
        assert_eq!(*events.lock().unwrap(), vec![1024]);
    }
}
