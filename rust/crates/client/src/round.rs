//! Owned round inputs and network results. SQLite never leaves its owner.
use std::collections::BTreeMap;

use ssp2::model::{Frame, MediaType, Message, MsgKind, SubStatus};
use ssp2::{decode_message, encode_message};

use crate::client::RequestMeta;
use crate::{
    BlobUploadGrant, ProgressObserver, ProgressPhase, SegmentRequest, SyncOutcome, Transport,
    TransportError,
};

pub(crate) fn now_ms(fixed: Option<i64>) -> i64 {
    fixed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock predates Unix epoch")
            .as_millis() as i64
    })
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
    /// `round_deadline` budget on the round's first exchange and carried
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
    /// Run network I/O without accessing client state. Download errors stay at
    /// their descriptor's position so apply retains the same completed prefix.
    pub fn exchange(mut self, transport: &mut dyn Transport) -> CompletedSyncRound {
        // Anchor the round deadline once, on the first exchange; a continuation
        // reuses the carried anchor instead of refreshing it. Scoping it to the
        // exchange keeps the reused transport free of stale deadline state.
        if self.round_deadline_at.is_none() {
            if let Some(budget) = transport.round_deadline() {
                match std::time::Instant::now().checked_add(budget) {
                    Some(deadline) => self.round_deadline_at = Some(deadline),
                    // Reject an unrepresentable host budget before network I/O.
                    None => {
                        return CompletedSyncRound {
                            prepared: self,
                            exchange: ExchangeResult::Reply {
                                response: Err(TransportError::new(
                                    "sync.invalid_request",
                                    "transport round deadline is out of range",
                                )),
                                transport_failed: false,
                                downloads: DownloadResults::default(),
                            },
                        }
                    }
                }
            }
        }
        transport.set_round_deadline(self.round_deadline_at);
        if let Some(upload) = self.uploads.pop_front() {
            let result = upload.bytes.and_then(|bytes| {
                upload_one(
                    transport,
                    &upload.id,
                    &bytes,
                    upload.media_type.as_deref(),
                    self.fixed_now,
                )
            });
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
                            let started_at = now_ms(self.fixed_now);
                            let key = match url {
                                Some(url) => DownloadKey::Url(url.clone()),
                                None => DownloadKey::Segment(
                                    segment_id.clone(),
                                    table.clone(),
                                    scopes.to_owned(),
                                ),
                            };
                            self.progress.update(|p| {
                                p.phase = ProgressPhase::Download;
                                p.subscription_id = Some(id.to_owned());
                                p.table = Some(table.clone());
                                p.segment_id = Some(segment_id.clone());
                                p.bytes_received = 0;
                                p.bytes_total = u64::try_from(*byte_length).ok();
                                p.rows_processed = 0;
                                p.rows_total = u64::try_from(*row_count).ok();
                            });
                            let mut on_progress =
                                |bytes| self.progress.update(|p| p.bytes_received = bytes);
                            let bytes = if let Some(url) = url {
                                if url_expires_at_ms.is_some_and(|expiry| expiry <= started_at) {
                                    Err(TransportError::new(
                                        "sync.segment_expired",
                                        "signed segment URL expired before fetch",
                                    ))
                                } else {
                                    transport.fetch_url(url, &mut on_progress)
                                }
                            } else {
                                transport.download_segment(
                                    &SegmentRequest {
                                        segment_id: segment_id.clone(),
                                        table: table.clone(),
                                        requested_scopes_json: scopes.to_owned(),
                                    },
                                    &mut on_progress,
                                )
                            };
                            let failed = bytes.is_err();
                            downloads.entries.push_back((key, started_at, bytes));
                            if failed {
                                break;
                            }
                        }
                        _ => {}
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
}
