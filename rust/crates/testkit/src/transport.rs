use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Map, Value};
use syncular_runtime::binary_snapshot::SnapshotChunkRows;
use syncular_runtime::error::{ErrorKind, Result, SyncularError};
use syncular_runtime::protocol::{
    BlobRef, CombinedRequest, CombinedResponse, OperationResult, PullResponse, PushBatchResponse,
    PushCommitRequest, PushCommitResponse, ScopeValues, ScopedSnapshotArtifactRef,
    SnapshotChunkRef, SubscriptionResponse,
};
use syncular_runtime::transport::{
    BlobTransport, RealtimeEvent, RealtimeTransport, SyncAuthHeaderStore, SyncAuthHeaders,
    SyncTransport,
};

#[derive(Debug, Clone)]
pub struct SnapshotChunkFetch {
    pub chunk: SnapshotChunkRef,
    pub scopes: ScopeValues,
}

#[derive(Debug, Clone)]
pub struct SnapshotArtifactFetch {
    pub artifact: ScopedSnapshotArtifactRef,
    pub scopes: ScopeValues,
}

#[derive(Debug, Clone)]
pub struct BlobUploadRecord {
    pub blob: BlobRef,
    pub bytes: Vec<u8>,
}

type HttpResponseFn = dyn Fn(&CombinedRequest) -> Result<CombinedResponse> + Send + Sync + 'static;

enum QueuedHttpResponse {
    Static(CombinedResponse),
    Dynamic(Box<HttpResponseFn>),
}

#[derive(Default)]
struct TestTransportState {
    requests: Vec<CombinedRequest>,
    ws_pushes: Vec<PushCommitRequest>,
    chunk_fetches: Vec<SnapshotChunkFetch>,
    artifact_fetches: Vec<SnapshotArtifactFetch>,
    auth_headers: Vec<SyncAuthHeaders>,
    realtime_events: VecDeque<RealtimeEvent>,
    http_responses: VecDeque<QueuedHttpResponse>,
    ws_push_responses: VecDeque<PushCommitResponse>,
    chunk_rows: VecDeque<SnapshotChunkRows>,
    artifact_bytes: VecDeque<Vec<u8>>,
    blob_uploads: Vec<BlobUploadRecord>,
    blobs: BTreeMap<String, Vec<u8>>,
    closed_realtime_count: usize,
}

#[derive(Clone, Default)]
pub struct TestTransport {
    state: Arc<Mutex<TestTransportState>>,
}

#[derive(Clone)]
pub struct TestTransportHandle {
    state: Arc<Mutex<TestTransportState>>,
}

#[derive(Clone)]
pub struct TestRealtime {
    state: Arc<Mutex<TestTransportState>>,
}

impl TestTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn handle(&self) -> TestTransportHandle {
        TestTransportHandle {
            state: self.state.clone(),
        }
    }

    pub fn push_http_response(&self, response: CombinedResponse) {
        self.state
            .lock()
            .expect("test transport state")
            .http_responses
            .push_back(QueuedHttpResponse::Static(response));
    }

    pub fn push_http_response_fn<F>(&self, response_fn: F)
    where
        F: Fn(&CombinedRequest) -> Result<CombinedResponse> + Send + Sync + 'static,
    {
        self.state
            .lock()
            .expect("test transport state")
            .http_responses
            .push_back(QueuedHttpResponse::Dynamic(Box::new(response_fn)));
    }

    pub fn push_ws_push_response(&self, response: PushCommitResponse) {
        self.state
            .lock()
            .expect("test transport state")
            .ws_push_responses
            .push_back(response);
    }

    pub fn push_realtime_event(&self, event: RealtimeEvent) {
        self.state
            .lock()
            .expect("test transport state")
            .realtime_events
            .push_back(event);
    }

    pub fn push_snapshot_chunk_rows(&self, rows: Vec<Value>) {
        self.state
            .lock()
            .expect("test transport state")
            .chunk_rows
            .push_back(SnapshotChunkRows::Json(rows));
    }

    pub fn push_snapshot_artifact_bytes(&self, bytes: Vec<u8>) {
        self.state
            .lock()
            .expect("test transport state")
            .artifact_bytes
            .push_back(bytes);
    }

    pub fn seed_blob(&self, blob: &BlobRef, bytes: Vec<u8>) {
        self.state
            .lock()
            .expect("test transport state")
            .blobs
            .insert(blob.hash.clone(), bytes);
    }
}

impl TestTransportHandle {
    pub fn requests(&self) -> Vec<CombinedRequest> {
        self.state
            .lock()
            .expect("test transport state")
            .requests
            .clone()
    }

    pub fn request_count(&self) -> usize {
        self.state
            .lock()
            .expect("test transport state")
            .requests
            .len()
    }

    pub fn last_request(&self) -> Option<CombinedRequest> {
        self.state
            .lock()
            .expect("test transport state")
            .requests
            .last()
            .cloned()
    }

    pub fn ws_pushes(&self) -> Vec<PushCommitRequest> {
        self.state
            .lock()
            .expect("test transport state")
            .ws_pushes
            .clone()
    }

    pub fn chunk_fetches(&self) -> Vec<SnapshotChunkFetch> {
        self.state
            .lock()
            .expect("test transport state")
            .chunk_fetches
            .clone()
    }

    pub fn artifact_fetches(&self) -> Vec<SnapshotArtifactFetch> {
        self.state
            .lock()
            .expect("test transport state")
            .artifact_fetches
            .clone()
    }

    pub fn auth_headers(&self) -> Vec<SyncAuthHeaders> {
        self.state
            .lock()
            .expect("test transport state")
            .auth_headers
            .clone()
    }

    pub fn blob_uploads(&self) -> Vec<BlobUploadRecord> {
        self.state
            .lock()
            .expect("test transport state")
            .blob_uploads
            .clone()
    }

    pub fn closed_realtime_count(&self) -> usize {
        self.state
            .lock()
            .expect("test transport state")
            .closed_realtime_count
    }
}

impl SyncAuthHeaderStore for TestTransport {
    fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.state
            .lock()
            .expect("test transport state")
            .auth_headers
            .push(headers);
    }
}

impl SyncTransport for TestTransport {
    type Realtime = TestRealtime;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse> {
        let response = {
            let mut state = self.state.lock().expect("test transport state");
            state.requests.push(request.clone());
            state.http_responses.pop_front()
        };
        if let Some(response) = response {
            return match response {
                QueuedHttpResponse::Static(response) => Ok(response),
                QueuedHttpResponse::Dynamic(response_fn) => response_fn(request),
            };
        }
        Ok(default_combined_response(request))
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &Map<String, Value>,
    ) -> Result<SnapshotChunkRows> {
        let mut state = self.state.lock().expect("test transport state");
        state.chunk_fetches.push(SnapshotChunkFetch {
            chunk: chunk.clone(),
            scopes: scopes.clone(),
        });
        Ok(state
            .chunk_rows
            .pop_front()
            .unwrap_or_else(|| SnapshotChunkRows::Json(Vec::new())))
    }

    fn fetch_snapshot_artifact_bytes(
        &self,
        artifact: &ScopedSnapshotArtifactRef,
        scopes: &Map<String, Value>,
    ) -> Result<Vec<u8>> {
        let mut state = self.state.lock().expect("test transport state");
        state.artifact_fetches.push(SnapshotArtifactFetch {
            artifact: artifact.clone(),
            scopes: scopes.clone(),
        });
        state.artifact_bytes.pop_front().ok_or_else(|| {
            SyncularError::protocol_message("no snapshot artifact bytes queued in TestTransport")
        })
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        Ok(TestRealtime {
            state: self.state.clone(),
        })
    }
}

impl BlobTransport for TestTransport {
    fn upload_blob(&self, blob: &BlobRef, bytes: &[u8]) -> Result<()> {
        let mut state = self.state.lock().expect("test transport state");
        state.blob_uploads.push(BlobUploadRecord {
            blob: blob.clone(),
            bytes: bytes.to_vec(),
        });
        state.blobs.insert(blob.hash.clone(), bytes.to_vec());
        Ok(())
    }

    fn download_blob(&self, blob: &BlobRef) -> Result<Vec<u8>> {
        self.state
            .lock()
            .expect("test transport state")
            .blobs
            .get(&blob.hash)
            .cloned()
            .ok_or_else(|| {
                SyncularError::message(
                    ErrorKind::Transport,
                    format!("test blob not found: {}", blob.hash),
                )
            })
    }
}

impl RealtimeTransport for TestRealtime {
    fn push_commit(&mut self, commit: PushCommitRequest) -> Result<PushCommitResponse> {
        let mut state = self.state.lock().expect("test transport state");
        let response = state
            .ws_push_responses
            .pop_front()
            .unwrap_or_else(|| default_push_commit_response(&commit));
        state.ws_pushes.push(commit);
        Ok(response)
    }

    fn read_event(&mut self) -> Result<Option<RealtimeEvent>> {
        Ok(self
            .state
            .lock()
            .expect("test transport state")
            .realtime_events
            .pop_front())
    }

    fn close(&mut self) {
        self.state
            .lock()
            .expect("test transport state")
            .closed_realtime_count += 1;
    }
}

pub fn empty_combined_response() -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: Some(PullResponse {
            ok: true,
            subscriptions: Vec::new(),
        }),
    }
}

pub fn default_combined_response(request: &CombinedRequest) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: request.push.as_ref().map(|push| PushBatchResponse {
            ok: true,
            commits: push
                .commits
                .iter()
                .map(default_push_commit_response)
                .collect(),
        }),
        pull: request.pull.as_ref().map(|pull| PullResponse {
            ok: true,
            subscriptions: pull
                .subscriptions
                .iter()
                .map(|subscription| SubscriptionResponse {
                    id: subscription.id.clone(),
                    status: "active".to_string(),
                    scopes: subscription.scopes.clone(),
                    bootstrap: false,
                    bootstrap_state: None,
                    next_cursor: subscription.cursor.max(0),
                    integrity: None,
                    commits: Vec::new(),
                    snapshots: None,
                })
                .collect(),
        }),
    }
}

pub fn default_push_commit_response(commit: &PushCommitRequest) -> PushCommitResponse {
    PushCommitResponse {
        client_commit_id: commit.client_commit_id.clone(),
        status: "applied".to_string(),
        commit_seq: Some(1),
        results: commit
            .operations
            .iter()
            .enumerate()
            .map(|(index, _)| OperationResult {
                op_index: index as i32,
                status: "applied".to_string(),
                message: None,
                error: None,
                code: None,
                retriable: None,
                server_version: Some(1),
                server_row: None,
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPhase {
    Before,
    After,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultOperation {
    AnySync,
    Push,
    Pull,
    SnapshotChunk,
    RealtimeConnect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FaultAction {
    Fail { message: String },
    Delay { duration: Duration },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaultStep {
    pub phase: FaultPhase,
    pub operation: FaultOperation,
    pub action: FaultAction,
    pub remaining: usize,
}

impl FaultStep {
    pub fn fail(phase: FaultPhase, operation: FaultOperation, message: impl Into<String>) -> Self {
        Self {
            phase,
            operation,
            action: FaultAction::Fail {
                message: message.into(),
            },
            remaining: 1,
        }
    }

    pub fn delay(phase: FaultPhase, operation: FaultOperation, duration: Duration) -> Self {
        Self {
            phase,
            operation,
            action: FaultAction::Delay { duration },
            remaining: 1,
        }
    }

    pub fn repeat(mut self, remaining: usize) -> Self {
        self.remaining = remaining;
        self
    }
}

#[derive(Debug, Default)]
struct FaultState {
    steps: VecDeque<FaultStep>,
    failures: usize,
    delays: usize,
}

#[derive(Debug, Clone)]
pub struct FaultTransport<T> {
    inner: T,
    state: Arc<Mutex<FaultState>>,
}

#[derive(Debug, Clone)]
pub struct FaultHandle {
    state: Arc<Mutex<FaultState>>,
}

impl<T> FaultTransport<T> {
    pub fn new(inner: T, steps: impl IntoIterator<Item = FaultStep>) -> Self {
        Self {
            inner,
            state: Arc::new(Mutex::new(FaultState {
                steps: steps.into_iter().collect(),
                failures: 0,
                delays: 0,
            })),
        }
    }

    pub fn handle(&self) -> FaultHandle {
        FaultHandle {
            state: self.state.clone(),
        }
    }

    pub fn into_inner(self) -> T {
        self.inner
    }
}

impl FaultHandle {
    pub fn failures(&self) -> usize {
        self.state.lock().expect("fault state").failures
    }

    pub fn delays(&self) -> usize {
        self.state.lock().expect("fault state").delays
    }

    pub fn remaining_steps(&self) -> usize {
        self.state.lock().expect("fault state").steps.len()
    }
}

impl<T> SyncTransport for FaultTransport<T>
where
    T: SyncTransport,
{
    type Realtime = T::Realtime;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse> {
        let operation = request_fault_operation(request);
        apply_fault(&self.state, FaultPhase::Before, operation)?;
        let response = self.inner.post_sync(request);
        apply_fault(&self.state, FaultPhase::After, operation)?;
        response
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &Map<String, Value>,
    ) -> Result<SnapshotChunkRows> {
        apply_fault(
            &self.state,
            FaultPhase::Before,
            FaultOperation::SnapshotChunk,
        )?;
        let rows = self.inner.fetch_snapshot_chunk_rows(chunk, scopes);
        apply_fault(
            &self.state,
            FaultPhase::After,
            FaultOperation::SnapshotChunk,
        )?;
        rows
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        apply_fault(
            &self.state,
            FaultPhase::Before,
            FaultOperation::RealtimeConnect,
        )?;
        let realtime = self.inner.connect_realtime();
        apply_fault(
            &self.state,
            FaultPhase::After,
            FaultOperation::RealtimeConnect,
        )?;
        realtime
    }
}

impl<T> BlobTransport for FaultTransport<T>
where
    T: BlobTransport,
{
    fn upload_blob(&self, blob: &BlobRef, bytes: &[u8]) -> Result<()> {
        self.inner.upload_blob(blob, bytes)
    }

    fn download_blob(&self, blob: &BlobRef) -> Result<Vec<u8>> {
        self.inner.download_blob(blob)
    }
}

impl<T> SyncAuthHeaderStore for FaultTransport<T>
where
    T: SyncAuthHeaderStore,
{
    fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.inner.set_auth_headers(headers);
    }
}

fn request_fault_operation(request: &CombinedRequest) -> FaultOperation {
    if request.push.is_some() {
        FaultOperation::Push
    } else if request.pull.is_some() {
        FaultOperation::Pull
    } else {
        FaultOperation::AnySync
    }
}

fn operation_matches(expected: FaultOperation, actual: FaultOperation) -> bool {
    expected == FaultOperation::AnySync || expected == actual
}

fn apply_fault(
    state: &Arc<Mutex<FaultState>>,
    phase: FaultPhase,
    operation: FaultOperation,
) -> Result<()> {
    let action =
        {
            let mut state = state.lock().expect("fault state");
            let Some(index) = state.steps.iter().position(|step| {
                step.phase == phase && operation_matches(step.operation, operation)
            }) else {
                return Ok(());
            };

            let mut step = state.steps.remove(index).expect("fault step");
            let action = step.action.clone();
            if step.remaining > 1 {
                step.remaining -= 1;
                state.steps.insert(index, step);
            }
            match action {
                FaultAction::Fail { .. } => state.failures += 1,
                FaultAction::Delay { .. } => state.delays += 1,
            }
            action
        };

    match action {
        FaultAction::Fail { message } => Err(SyncularError::message(ErrorKind::Transport, message)),
        FaultAction::Delay { duration } => {
            thread::sleep(duration);
            Ok(())
        }
    }
}
