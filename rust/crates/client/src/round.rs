//! Owned round inputs and network results. SQLite never leaves its owner.
use std::collections::BTreeMap;

use ssp2::model::{Frame, MediaType, Message, MsgKind, SubStatus};
use ssp2::{decode_message, encode_message};

use crate::client::RequestMeta;
use crate::{
    BlobUploadGrant, ProgressObserver, ProgressPhase, SegmentFetch, SegmentRequest, SyncOutcome,
    Transport, TransportError,
};

pub(crate) fn now_ms(fixed: Option<i64>) -> i64 {
    fixed.unwrap_or_else(crate::wall_clock_ms)
}

pub(crate) struct PendingUpload {
    pub id: String,
    pub bytes: Result<Vec<u8>, TransportError>,
    pub media_type: Option<String>,
}

pub(crate) fn upload_one(
    transport: &mut dyn Transport,
    id: &str,
    bytes: &[u8],
    media_type: Option<&str>,
    fixed_now: Option<i64>,
) -> Result<(), TransportError> {
    match transport.blob_upload_grant(id, bytes.len() as u64, media_type)? {
        BlobUploadGrant::Present => return Ok(()),
        BlobUploadGrant::Url {
            url,
            url_expires_at_ms,
        } => {
            if url_expires_at_ms.is_none_or(|expiry| expiry > now_ms(fixed_now))
                && transport.blob_put_url(&url, bytes, media_type).is_ok()
            {
                return Ok(());
            }
        }
        BlobUploadGrant::None => {}
    }
    transport.blob_upload(id, bytes, media_type)
}

/// Immutable request and blob bodies captured by the mutable client owner.
/// Send this value to an I/O executor; it contains no SQLite connection.
pub struct PreparedSyncRound {
    pub(crate) id: uuid::Uuid,
    pub(crate) started_at_ms: i64,
    pub(crate) meta: RequestMeta,
    pub(crate) message: Message,
    pub(crate) realtime: bool,
    pub(crate) uploads: std::collections::VecDeque<PendingUpload>,
    pub(crate) scopes: BTreeMap<String, String>,
    #[cfg(feature = "bench-internals")]
    pub(crate) benchmark_phases: crate::bench::Recorder,
    pub(crate) progress: ProgressObserver,
    pub(crate) fixed_now: Option<i64>,
    /// Absolute whole-round network deadline, anchored from the transport's
    /// `round_deadline` budget on the round's first network call and carried
    /// across `Continue`s. `exchange` scopes it onto the transport for the
    /// duration of each network call.
    pub(crate) round_deadline_at: Option<std::time::Instant>,
}

/// Network results returned to the same mutable owner that prepared the round.
pub struct CompletedSyncRound {
    pub(crate) prepared: PreparedSyncRound,
    pub(crate) exchange: ExchangeResult,
}

pub(crate) enum ExchangeResult {
    Upload {
        id: String,
        result: Result<(), TransportError>,
    },
    Reply {
        response: Result<Message, TransportError>,
        transport_failed: bool,
        downloads: DownloadResults,
    },
}

/// A completed upload returns to the owner to persist its pin removal before
/// any metadata push. A completed response returns its durable apply outcome.
pub enum AppliedSyncRound {
    Continue(PreparedSyncRound),
    Complete {
        outcome: SyncOutcome,
        controls: Vec<String>,
        /// The same continuation predicate used by `sync_until_idle`.
        more: bool,
        /// A bootstrap page advanced, renewing an unbounded idle run's budget.
        bootstrap_advanced: bool,
    },
}

impl PreparedSyncRound {
    /// Scope the round deadline for one network call. The round anchors its
    /// deadline on its first network call, so local work before that call does
    /// not consume the network budget; the anchor is absolute from then on, and
    /// a continuation reuses the carried anchor instead of refreshing it.
    fn scope_round_deadline(
        &mut self,
        transport: &mut dyn Transport,
    ) -> Result<(), TransportError> {
        if self.round_deadline_at.is_none() {
            if let Some(budget) = transport.round_deadline() {
                // A wasm32-unknown-unknown host has no `Instant`, so there is
                // nothing to anchor the budget to. Report that instead of
                // panicking inside `Instant::now()`.
                #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
                {
                    let _ = budget;
                    return Err(TransportError::new(
                        "sync.invalid_request",
                        "transport round deadline is unsupported on wasm32-unknown-unknown",
                    ));
                }
                #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
                match std::time::Instant::now().checked_add(budget) {
                    Some(deadline) => self.round_deadline_at = Some(deadline),
                    // Reject an unrepresentable host budget before network I/O.
                    None => {
                        return Err(TransportError::new(
                            "sync.invalid_request",
                            "transport round deadline is out of range",
                        ))
                    }
                }
            }
        }
        transport.set_round_deadline(self.round_deadline_at);
        Ok(())
    }

    /// Run network I/O without accessing client state. Download errors stay at
    /// their descriptor's position so apply retains the same completed prefix.
    pub fn exchange(mut self, transport: &mut dyn Transport) -> CompletedSyncRound {
        if let Some(upload) = self.uploads.pop_front() {
            // A staged body that failed to read locally performs no network
            // I/O, so it cannot be the round's first network call and must not
            // anchor the round deadline either.
            let result = match upload.bytes {
                Ok(bytes) => self.scope_round_deadline(transport).and_then(|()| {
                    upload_one(
                        transport,
                        &upload.id,
                        &bytes,
                        upload.media_type.as_deref(),
                        self.fixed_now,
                    )
                }),
                Err(error) => Err(error),
            };
            transport.set_round_deadline(None);
            return CompletedSyncRound {
                prepared: self,
                exchange: ExchangeResult::Upload {
                    id: upload.id,
                    result,
                },
            };
        }
        let mut transport_failed = false;
        let response = (|| {
            #[cfg(feature = "bench-internals")]
            let encode_phase = self
                .benchmark_phases
                .start(crate::bench::Phase::RequestEncode);
            let request = encode_message(&self.message);
            #[cfg(feature = "bench-internals")]
            drop(encode_phase);
            // The round's first network call anchors the deadline here, after
            // the encode; a continuation's encode runs against the already
            // anchored deadline like the rest of the round (§1.8).
            self.scope_round_deadline(transport)?;
            let round = if self.realtime {
                transport.realtime_sync(&request)
            } else {
                transport.sync(&request)
            };
            transport_failed = round.is_err();
            let bytes = round?;
            #[cfg(feature = "bench-internals")]
            let _decode_phase = self
                .benchmark_phases
                .start(crate::bench::Phase::ResponseDecode);
            let response = decode_message(&bytes)
                .map_err(|e| TransportError::new(e.code.as_str(), e.detail))?;
            if response.msg_kind != MsgKind::Response {
                return Err(TransportError::new(
                    "sync.invalid_request",
                    "expected a response message",
                ));
            }
            Ok(response)
        })();
        let mut downloads = DownloadResults::default();
        if let Ok(response) = &response {
            // A reset/floor/invalid header cannot authorize any segment fetch.
            if matches!(response.frames.first(), Some(Frame::RespHeader { required_schema_version: None, reset_required: Some(false), log_epoch: Some(epoch), .. }) if self.message.frames.first().is_some_and(|f| matches!(f, Frame::ReqHeader { log_epoch: Some(request_epoch), .. } if request_epoch == epoch)))
            {
                let mut scope: Option<(&str, &str)> = None;
                // §5.4 / §5.5: collect every eligible descriptor first so the
                // transport can overlap the fetches. One batch start is the
                // fetch start for the expiry rule.
                let batch_started_at = now_ms(self.fixed_now);
                let mut planned: Vec<PlannedFetch> = Vec::new();
                for frame in &response.frames {
                    match frame {
                        Frame::SubStart {
                            id,
                            status: SubStatus::Active,
                            ..
                        } => {
                            scope = self
                                .scopes
                                .get(id)
                                .map(|scopes| (id.as_str(), scopes.as_str()));
                        }
                        Frame::SubStart { .. } | Frame::SubEnd { .. } => scope = None,
                        Frame::Error { .. } => break,
                        Frame::SegmentRef {
                            segment_id,
                            table,
                            media_type,
                            url,
                            url_expires_at_ms,
                            byte_length,
                            row_count,
                            ..
                        } => {
                            let Some((id, scopes)) = scope else { continue };
                            let advertised = match media_type {
                                MediaType::Rows => self.meta.accept & 3 != 0,
                                MediaType::Sqlite => self.meta.accept & 4 != 0,
                            };
                            if !advertised || (url.is_some() && self.meta.accept & 8 == 0) {
                                break;
                            }
                            let expired = url.is_some()
                                && url_expires_at_ms
                                    .is_some_and(|expiry| expiry <= batch_started_at);
                            let (key, fetch) = match url {
                                Some(url) => (
                                    DownloadKey::Url(url.clone()),
                                    if expired {
                                        None
                                    } else {
                                        Some(SegmentFetch::Url(url.clone()))
                                    },
                                ),
                                None => (
                                    DownloadKey::Segment(
                                        segment_id.clone(),
                                        table.clone(),
                                        scopes.to_owned(),
                                    ),
                                    Some(SegmentFetch::Direct(SegmentRequest {
                                        segment_id: segment_id.clone(),
                                        table: table.clone(),
                                        requested_scopes_json: scopes.to_owned(),
                                    })),
                                ),
                            };
                            planned.push(PlannedFetch {
                                key,
                                subscription_id: id.to_owned(),
                                table: table.clone(),
                                segment_id: segment_id.clone(),
                                bytes_total: u64::try_from(*byte_length).ok(),
                                rows_total: u64::try_from(*row_count).ok(),
                                fetch,
                            });
                            if expired {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if !planned.is_empty() {
                    let progress = self.progress.clone();
                    let mut on_progress = |index: usize, bytes: u64| {
                        let Some(planned_fetch) = planned.get(index) else {
                            return;
                        };
                        progress.update(|p| {
                            p.phase = ProgressPhase::Download;
                            p.subscription_id = Some(planned_fetch.subscription_id.clone());
                            p.table = Some(planned_fetch.table.clone());
                            p.segment_id = Some(planned_fetch.segment_id.clone());
                            p.bytes_received = bytes;
                            p.bytes_total = planned_fetch.bytes_total;
                            p.rows_processed = 0;
                            p.rows_total = planned_fetch.rows_total;
                        });
                    };
                    // Announce the download phase before the first byte lands.
                    on_progress(0, 0);
                    let fetches: Vec<SegmentFetch> = planned
                        .iter()
                        .filter_map(|planned_fetch| planned_fetch.fetch.clone())
                        .collect();
                    let mut results = transport
                        .download_segments(&fetches, &mut on_progress)
                        .into_iter();
                    for planned_fetch in planned {
                        let result = match planned_fetch.fetch {
                            None => Err(TransportError::new(
                                "sync.segment_expired",
                                "signed segment URL expired before fetch",
                            )),
                            // A shorter result list means the batch stopped
                            // after an earlier error, and apply aborts there.
                            Some(_) => match results.next() {
                                Some(result) => result,
                                None => break,
                            },
                        };
                        let failed = result.is_err();
                        downloads
                            .entries
                            .push_back((planned_fetch.key, batch_started_at, result));
                        if failed {
                            break;
                        }
                    }
                }
            }
        }
        transport.set_round_deadline(None);
        CompletedSyncRound {
            prepared: self,
            exchange: ExchangeResult::Reply {
                response,
                downloads,
                transport_failed,
            },
        }
    }
}

#[derive(PartialEq)]
enum DownloadKey {
    Url(String),
    Segment(String, String, String),
}

/// One eligible `SEGMENT_REF` of the response, collected before the batch
/// fetch so `download_segments` sees the whole page list at once.
struct PlannedFetch {
    key: DownloadKey,
    subscription_id: String,
    table: String,
    segment_id: String,
    bytes_total: Option<u64>,
    rows_total: Option<u64>,
    /// `None` when the signed URL had already expired at the batch start: the
    /// fetch is never attempted and its descriptor fails with
    /// `sync.segment_expired`. Collection stops there, so only the last
    /// collected fetch can be `None`.
    fetch: Option<SegmentFetch>,
}

#[derive(Default)]
pub(crate) struct DownloadResults {
    entries: std::collections::VecDeque<(DownloadKey, i64, Result<Vec<u8>, TransportError>)>,
    pub controls: Vec<String>,
}

impl DownloadResults {
    fn take(&mut self, key: DownloadKey) -> Result<Vec<u8>, TransportError> {
        let position = self
            .entries
            .iter()
            .position(|(candidate, ..)| *candidate == key);
        position
            .and_then(|i| self.entries.remove(i))
            .map(|(_, _, bytes)| bytes)
            .unwrap_or_else(|| {
                Err(TransportError::new(
                    "client.round_download_missing",
                    "round apply requested an uncaptured segment",
                ))
            })
    }
}

impl Transport for DownloadResults {
    fn sync(&mut self, _: &[u8]) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new(
            "client.round_network_on_owner",
            "network requests must execute outside the client owner",
        ))
    }
    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }
    fn download_segment(
        &mut self,
        request: &SegmentRequest,
        _: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        self.take(DownloadKey::Segment(
            request.segment_id.clone(),
            request.table.clone(),
            request.requested_scopes_json.clone(),
        ))
    }
    fn fetch_url(&mut self, url: &str, _: &mut dyn FnMut(u64)) -> Result<Vec<u8>, TransportError> {
        self.take(DownloadKey::Url(url.to_owned()))
    }
    fn segment_fetch_started_at(&self, url: &str) -> Option<i64> {
        self.entries
            .iter()
            .find_map(|(key, time, _)| (*key == DownloadKey::Url(url.to_owned())).then_some(*time))
    }
    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Err(TransportError::new(
            "client.round_network_on_owner",
            "network connections must execute outside the client owner",
        ))
    }
    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        self.controls.push(text.to_owned());
        Ok(())
    }
    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlobUploadGrant, SegmentRequest, TransportError};

    /// Every upload call fails with the same typed timeout, modelling a round
    /// whose deadline was spent before the signed upload. The fallback to the
    /// direct endpoint must not replace the typed code with a generic one.
    struct SpentDeadline;

    impl Transport for SpentDeadline {
        fn sync(&mut self, _: &[u8]) -> Result<Vec<u8>, TransportError> {
            unreachable!()
        }
        fn realtime_sync(&mut self, _: &[u8]) -> Result<Vec<u8>, TransportError> {
            unreachable!()
        }
        fn download_segment(
            &mut self,
            _: &SegmentRequest,
            _: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            unreachable!()
        }
        fn blob_upload_grant(
            &mut self,
            _: &str,
            _: u64,
            _: Option<&str>,
        ) -> Result<BlobUploadGrant, TransportError> {
            Ok(BlobUploadGrant::Url {
                url: "https://storage.example/signed".into(),
                url_expires_at_ms: None,
            })
        }
        fn blob_put_url(
            &mut self,
            _: &str,
            _: &[u8],
            _: Option<&str>,
        ) -> Result<(), TransportError> {
            Err(TransportError::new(
                "transport.timeout",
                "signed upload timed out",
            ))
        }
        fn blob_upload(
            &mut self,
            _: &str,
            _: &[u8],
            _: Option<&str>,
        ) -> Result<(), TransportError> {
            Err(TransportError::new(
                "transport.timeout",
                "direct upload timed out",
            ))
        }
        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
        fn realtime_send(&mut self, _: &str) -> Result<(), TransportError> {
            Ok(())
        }
        fn realtime_close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    #[test]
    fn a_spent_round_deadline_survives_the_signed_upload_fallback() {
        let mut transport = SpentDeadline;
        let error = upload_one(&mut transport, "sha256:test", &[0u8; 4], None, None).unwrap_err();
        assert_eq!(error.code, "transport.timeout");
    }

    /// Records each single fetch the default batch runs and fails the second.
    #[derive(Default)]
    struct CountingFetches {
        calls: Vec<String>,
    }

    impl Transport for CountingFetches {
        fn sync(&mut self, _: &[u8]) -> Result<Vec<u8>, TransportError> {
            unreachable!()
        }
        fn realtime_sync(&mut self, _: &[u8]) -> Result<Vec<u8>, TransportError> {
            unreachable!()
        }
        fn download_segment(
            &mut self,
            request: &SegmentRequest,
            on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            self.calls.push(request.segment_id.clone());
            on_progress(4);
            if request.segment_id == "sha256:b" {
                Err(TransportError::new(
                    "transport.timeout",
                    "second fetch failed",
                ))
            } else {
                Ok(request.segment_id.clone().into_bytes())
            }
        }
        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
        fn realtime_send(&mut self, _: &str) -> Result<(), TransportError> {
            Ok(())
        }
        fn realtime_close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    #[test]
    fn the_default_batch_runs_the_single_fetches_in_order_and_stops_at_the_first_error() {
        let mut transport = CountingFetches::default();
        let fetches: Vec<SegmentFetch> = ["a", "b", "c"]
            .into_iter()
            .map(|id| {
                SegmentFetch::Direct(SegmentRequest {
                    segment_id: format!("sha256:{id}"),
                    table: "tasks".to_owned(),
                    requested_scopes_json: "{}".to_owned(),
                })
            })
            .collect();
        let mut reported = Vec::new();
        let results = transport.download_segments(&fetches, &mut |index, bytes| {
            reported.push((index, bytes));
        });
        assert_eq!(
            transport.calls,
            vec!["sha256:a", "sha256:b"],
            "the third fetch was never attempted"
        );
        assert_eq!(results.len(), 2, "one result per attempted fetch");
        assert_eq!(results[0].as_ref().unwrap(), b"sha256:a");
        assert_eq!(results[1].as_ref().unwrap_err().code, "transport.timeout");
        assert_eq!(reported, vec![(0, 4), (1, 4)]);
    }
}
