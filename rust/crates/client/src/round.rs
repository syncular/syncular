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

/// One network operation of a prepared round.
///
/// A host that cannot block (a browser worker with `fetch`, a single-threaded
/// runtime) drives a round with [`PreparedSyncRound::next_operation`],
/// performs the operation with its own I/O, and returns the result with
/// [`PreparedSyncRound::submit`]. A host with a blocking [`Transport`] calls
/// [`PreparedSyncRound::exchange`], which runs the same operations in order.
#[derive(Debug)]
pub enum RoundOperation<'a> {
    /// `POST <mount>/blobs/{blob_id}/upload-grant` (§5.9.3).
    UploadGrant {
        blob_id: &'a str,
        byte_length: u64,
        media_type: Option<&'a str>,
    },
    /// `PUT` the presigned upload url the grant returned. A failure falls back
    /// to [`RoundOperation::Upload`] with the same body.
    UploadPut {
        url: &'a str,
        bytes: &'a [u8],
        media_type: Option<&'a str>,
    },
    /// `PUT <mount>/blobs/{blob_id}` through the direct endpoint.
    Upload {
        blob_id: &'a str,
        bytes: &'a [u8],
        media_type: Option<&'a str>,
    },
    /// The combined push+pull message. `realtime` selects the socket path
    /// (§8.7, [`Transport::realtime_sync`]) instead of `POST /sync` (§1.5).
    Sync { request: &'a [u8], realtime: bool },
    /// Every eligible segment body of the response, in wire order (§5.4 /
    /// §5.5). Fetch them in parallel if the host can; the core consumes the
    /// results in order and stops at the first failure.
    Downloads(&'a [SegmentFetch]),
}

/// The host's answer to a [`RoundOperation`].
#[derive(Debug)]
pub enum RoundReply {
    /// Answers [`RoundOperation::UploadGrant`] with the grant endpoint's body.
    UploadGrant(Result<BlobUploadGrant, TransportError>),
    /// Answers [`RoundOperation::UploadPut`] or [`RoundOperation::Upload`]. A
    /// failed PUT makes `submit` ask for `Upload` next.
    Upload(Result<(), TransportError>),
    /// Answers [`RoundOperation::Sync`] with the assembled response bytes.
    Sync(Result<Vec<u8>, TransportError>),
    /// Answers [`RoundOperation::Downloads`] with one result per fetch, in
    /// order.
    Downloads(Vec<Result<Vec<u8>, TransportError>>),
}

/// The phase of a host-driven round. Every variant except `Downloads` names
/// one network operation; `Downloads` carries the captured response while the
/// host fetches its segment bodies.
pub(crate) enum RoundPhase {
    UploadGrant,
    UploadPut {
        url: String,
    },
    UploadDirect,
    Sync,
    Downloads {
        planned: Vec<PlannedFetch>,
        fetches: Vec<SegmentFetch>,
        response: Message,
        batch_started_at: i64,
    },
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
    /// The encoded round message, filled on the first request that needs it.
    pub(crate) encoded: Option<Vec<u8>>,
    pub(crate) phase: RoundPhase,
    /// The phase that follows the completed upload exchange; consumed by the
    /// next drive of a round whose apply returned `Continue`.
    pub(crate) continuation: Option<RoundPhase>,
    /// Set when the current exchange has nothing left to fetch. `finish`
    /// returns it; `apply_sync_round` reads it.
    pub(crate) completed: Option<ExchangeResult>,
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
// The prepared round is the continuation and stays by value so a host keeps
// one type for both outcomes.
#[allow(clippy::large_enum_variant)]
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
    ///
    /// This drives the same [`RoundOperation`] sequence that a non-blocking
    /// host drives itself, so both paths share every decision the client
    /// makes about uploads, segment fetches, and deadline state.
    pub fn exchange(mut self, transport: &mut dyn Transport) -> CompletedSyncRound {
        let mut scoped = false;
        while self.completed.is_none() {
            let reply = {
                let Some(operation) = self.next_operation_scoped(transport, &mut scoped) else {
                    break;
                };
                match operation {
                    RoundOperation::UploadGrant {
                        blob_id,
                        byte_length,
                        media_type,
                    } => RoundReply::UploadGrant(transport.blob_upload_grant(
                        blob_id,
                        byte_length,
                        media_type,
                    )),
                    RoundOperation::UploadPut {
                        url,
                        bytes,
                        media_type,
                    } => RoundReply::Upload(transport.blob_put_url(url, bytes, media_type)),
                    RoundOperation::Upload {
                        blob_id,
                        bytes,
                        media_type,
                    } => RoundReply::Upload(transport.blob_upload(blob_id, bytes, media_type)),
                    RoundOperation::Sync { request, realtime } => RoundReply::Sync(if realtime {
                        transport.realtime_sync(request)
                    } else {
                        transport.sync(request)
                    }),
                    RoundOperation::Downloads(fetches) => {
                        RoundReply::Downloads(transport.download_segments(fetches, &mut |_, _| {}))
                    }
                }
            };
            self.submit(reply)
                .expect("the exchange answers its own operation");
        }
        transport.set_round_deadline(None);
        self.finish().expect("the exchange completed the round")
    }

    /// The encoded round message (§1.5). Uploads listed by
    /// [`RoundOperation::UploadGrant`] precede it; a host that drives the round
    /// with `exchange` never needs this call.
    pub fn request_bytes(&self) -> Vec<u8> {
        self.encoded
            .clone()
            .unwrap_or_else(|| encode_message(&self.message))
    }

    /// The next network operation a host must perform, or `None` once every
    /// operation of the current exchange is answered. Call
    /// [`PreparedSyncRound::submit`] with its result, then repeat.
    ///
    /// After an upload operation completes, the round is complete for this
    /// exchange: call [`PreparedSyncRound::finish`] and apply it, so the owner
    /// persists the pin removal before the metadata request. The applied
    /// round's `Continue` returns the prepared round for the next exchange.
    pub fn next_operation(&mut self) -> Option<RoundOperation<'_>> {
        let mut scoped = false;
        self.next_operation_impl(None, &mut scoped)
    }

    /// Hand the result of the last [`PreparedSyncRound::next_operation`] back.
    /// A reply of the wrong kind fails with `client.invalid_round_reply` and
    /// leaves the round where it was.
    pub fn submit(&mut self, reply: RoundReply) -> Result<(), TransportError> {
        if self.completed.is_some() {
            return Err(TransportError::new(
                "client.invalid_round_reply",
                "the exchange already has its reply",
            ));
        }
        let phase = std::mem::replace(&mut self.phase, RoundPhase::Sync);
        match (phase, reply) {
            (RoundPhase::UploadGrant, RoundReply::UploadGrant(Err(error))) => {
                let upload = self
                    .uploads
                    .pop_front()
                    .expect("an upload phase owns an upload");
                self.completed = Some(ExchangeResult::Upload {
                    id: upload.id,
                    result: Err(error),
                });
            }
            (RoundPhase::UploadGrant, RoundReply::UploadGrant(Ok(grant))) => match grant {
                BlobUploadGrant::Present => self.upload_complete(),
                BlobUploadGrant::Url {
                    url,
                    url_expires_at_ms,
                } => {
                    // §5.9.3: an expiry the host clock already passed skips the
                    // PUT; the direct endpoint still carries the body.
                    if url_expires_at_ms.is_none_or(|expiry| expiry > now_ms(self.fixed_now)) {
                        self.phase = RoundPhase::UploadPut { url };
                    } else {
                        self.phase = RoundPhase::UploadDirect;
                    }
                }
                BlobUploadGrant::None => self.phase = RoundPhase::UploadDirect,
            },
            (RoundPhase::UploadPut { .. }, RoundReply::Upload(Ok(()))) => self.upload_complete(),
            // A failed presigned PUT falls back to the direct endpoint with the
            // same body, exactly like `upload_one`.
            (RoundPhase::UploadPut { .. }, RoundReply::Upload(Err(_))) => {
                self.phase = RoundPhase::UploadDirect;
            }
            (RoundPhase::UploadDirect, RoundReply::Upload(Ok(()))) => self.upload_complete(),
            (RoundPhase::UploadDirect, RoundReply::Upload(Err(error))) => {
                let upload = self
                    .uploads
                    .pop_front()
                    .expect("an upload phase owns an upload");
                self.completed = Some(ExchangeResult::Upload {
                    id: upload.id,
                    result: Err(error),
                });
            }
            (RoundPhase::Sync, RoundReply::Sync(reply)) => {
                let transport_failed = reply.is_err();
                let response = reply.and_then(|bytes| {
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
                });
                let Ok(response) = response else {
                    self.completed = Some(ExchangeResult::Reply {
                        response,
                        transport_failed,
                        downloads: DownloadResults::default(),
                    });
                    return Ok(());
                };
                let mut planned: Vec<PlannedFetch> = Vec::new();
                // A reset/floor/invalid header cannot authorize any segment
                // fetch.
                if matches!(response.frames.first(), Some(Frame::RespHeader { required_schema_version: None, reset_required: Some(false), log_epoch: Some(epoch), .. }) if self.message.frames.first().is_some_and(|f| matches!(f, Frame::ReqHeader { log_epoch: Some(request_epoch), .. } if request_epoch == epoch)))
                {
                    let mut scope: Option<(&str, &str)> = None;
                    // §5.4 / §5.5: collect every eligible descriptor first so
                    // the host can overlap the fetches. One batch start is the
                    // fetch start for the expiry rule.
                    let batch_started_at = now_ms(self.fixed_now);
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
                        let on_progress = |index: usize, bytes: u64| {
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
                        self.phase = RoundPhase::Downloads {
                            planned,
                            fetches,
                            response,
                            batch_started_at,
                        };
                        return Ok(());
                    }
                }
                self.completed = Some(ExchangeResult::Reply {
                    response: Ok(response),
                    transport_failed,
                    downloads: DownloadResults::default(),
                });
            }
            (
                RoundPhase::Downloads {
                    planned,
                    batch_started_at,
                    response,
                    ..
                },
                RoundReply::Downloads(results),
            ) => {
                let mut downloads = DownloadResults::default();
                let progress = self.progress.clone();
                let mut results = results.into_iter();
                for planned_fetch in planned {
                    let result = match planned_fetch.fetch {
                        None => Err(TransportError::new(
                            "sync.segment_expired",
                            "signed segment URL expired before fetch",
                        )),
                        // A shorter result list means the batch stopped after an
                        // earlier error, and apply aborts there.
                        Some(_) => match results.next() {
                            Some(result) => result,
                            None => break,
                        },
                    };
                    if let Ok(bytes) = &result {
                        progress.update(|p| {
                            p.phase = ProgressPhase::Download;
                            p.subscription_id = Some(planned_fetch.subscription_id.clone());
                            p.table = Some(planned_fetch.table.clone());
                            p.segment_id = Some(planned_fetch.segment_id.clone());
                            p.bytes_received = bytes.len() as u64;
                            p.bytes_total = planned_fetch.bytes_total;
                            p.rows_processed = 0;
                            p.rows_total = planned_fetch.rows_total;
                        });
                    }
                    let failed = result.is_err();
                    downloads
                        .entries
                        .push_back((planned_fetch.key, batch_started_at, result));
                    if failed {
                        break;
                    }
                }
                self.completed = Some(ExchangeResult::Reply {
                    response: Ok(response),
                    transport_failed: false,
                    downloads,
                });
            }
            (phase, _) => {
                self.phase = phase;
                return Err(TransportError::new(
                    "client.invalid_round_reply",
                    "the reply does not answer the pending operation",
                ));
            }
        }
        Ok(())
    }

    /// The completed round once every operation is answered, ready for
    /// `SyncClient::apply_sync_round`.
    pub fn finish(mut self) -> Option<CompletedSyncRound> {
        let exchange = self.completed.take()?;
        Some(CompletedSyncRound {
            prepared: self,
            exchange,
        })
    }

    fn upload_complete(&mut self) {
        let upload = self
            .uploads
            .pop_front()
            .expect("an upload phase owns an upload");
        self.completed = Some(ExchangeResult::Upload {
            id: upload.id,
            result: Ok(()),
        });
        self.continuation = Some(if self.uploads.is_empty() {
            RoundPhase::Sync
        } else {
            RoundPhase::UploadGrant
        });
    }

    fn ensure_encoded(&mut self) {
        if self.encoded.is_none() {
            #[cfg(feature = "bench-internals")]
            let _phase = self
                .benchmark_phases
                .start(crate::bench::Phase::RequestEncode);
            self.encoded = Some(encode_message(&self.message));
        }
    }

    fn next_operation_scoped<'a>(
        &'a mut self,
        transport: &mut dyn Transport,
        scoped: &mut bool,
    ) -> Option<RoundOperation<'a>> {
        self.next_operation_impl(Some(transport), scoped)
    }

    fn next_operation_impl<'a>(
        &'a mut self,
        mut scope: Option<&mut dyn Transport>,
        scoped: &mut bool,
    ) -> Option<RoundOperation<'a>> {
        if self.completed.is_some() {
            return None;
        }
        // The previous exchange ended with an upload; the owner has applied it.
        if let Some(next) = self.continuation.take() {
            self.phase = next;
        }
        if matches!(self.phase, RoundPhase::UploadGrant) && self.uploads.is_empty() {
            self.phase = RoundPhase::Sync;
        }
        // A staged body that failed to read locally performs no network I/O,
        // so it cannot be the round's first network call and must not anchor
        // the round deadline either.
        if matches!(self.phase, RoundPhase::UploadGrant)
            && self
                .uploads
                .front()
                .is_some_and(|upload| upload.bytes.is_err())
        {
            let upload = self
                .uploads
                .pop_front()
                .expect("the failed upload is staged");
            self.completed = Some(ExchangeResult::Upload {
                id: upload.id,
                result: Err(upload.bytes.unwrap_err()),
            });
            return None;
        }
        if matches!(self.phase, RoundPhase::Sync) {
            self.ensure_encoded();
        }
        let needs_network = !matches!(self.phase, RoundPhase::Downloads { .. });
        // The round's first network call anchors the deadline after the
        // encode; a continuation reuses the carried anchor instead of
        // refreshing it.
        if needs_network && !*scoped {
            *scoped = true;
            if let Some(transport) = scope.as_mut() {
                if let Err(error) = self.scope_round_deadline(&mut **transport) {
                    if matches!(
                        self.phase,
                        RoundPhase::UploadGrant
                            | RoundPhase::UploadPut { .. }
                            | RoundPhase::UploadDirect
                    ) {
                        let upload = self
                            .uploads
                            .pop_front()
                            .expect("an upload phase owns an upload");
                        self.completed = Some(ExchangeResult::Upload {
                            id: upload.id,
                            result: Err(error),
                        });
                    } else {
                        self.completed = Some(ExchangeResult::Reply {
                            response: Err(error),
                            transport_failed: false,
                            downloads: DownloadResults::default(),
                        });
                    }
                    return None;
                }
            }
        }
        match &self.phase {
            RoundPhase::UploadGrant => {
                let upload = self
                    .uploads
                    .front()
                    .expect("an upload phase owns an upload");
                let bytes = upload
                    .bytes
                    .as_ref()
                    .expect("a staged body that failed to read has no operation");
                Some(RoundOperation::UploadGrant {
                    blob_id: &upload.id,
                    byte_length: bytes.len() as u64,
                    media_type: upload.media_type.as_deref(),
                })
            }
            RoundPhase::UploadPut { url, .. } => {
                let upload = self
                    .uploads
                    .front()
                    .expect("an upload phase owns an upload");
                let bytes = upload
                    .bytes
                    .as_ref()
                    .expect("a staged body that failed to read has no operation");
                Some(RoundOperation::UploadPut {
                    url,
                    bytes,
                    media_type: upload.media_type.as_deref(),
                })
            }
            RoundPhase::UploadDirect => {
                let upload = self
                    .uploads
                    .front()
                    .expect("an upload phase owns an upload");
                let bytes = upload
                    .bytes
                    .as_ref()
                    .expect("a staged body that failed to read has no operation");
                Some(RoundOperation::Upload {
                    blob_id: &upload.id,
                    bytes,
                    media_type: upload.media_type.as_deref(),
                })
            }
            RoundPhase::Sync => Some(RoundOperation::Sync {
                request: self.encoded.as_deref().expect("the request is encoded"),
                realtime: self.realtime,
            }),
            RoundPhase::Downloads { fetches, .. } => Some(RoundOperation::Downloads(fetches)),
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
pub(crate) struct PlannedFetch {
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
pub(crate) mod test_support {
    use super::*;

    /// Drive one exchange through the split API, answering every operation
    /// with the blocking transport under test.
    pub(crate) fn drive_round(
        mut prepared: PreparedSyncRound,
        transport: &mut dyn Transport,
    ) -> CompletedSyncRound {
        while let Some(operation) = prepared.next_operation() {
            let reply = match operation {
                RoundOperation::UploadGrant {
                    blob_id,
                    byte_length,
                    media_type,
                } => RoundReply::UploadGrant(transport.blob_upload_grant(
                    blob_id,
                    byte_length,
                    media_type,
                )),
                RoundOperation::UploadPut {
                    url,
                    bytes,
                    media_type,
                } => RoundReply::Upload(transport.blob_put_url(url, bytes, media_type)),
                RoundOperation::Upload {
                    blob_id,
                    bytes,
                    media_type,
                } => RoundReply::Upload(transport.blob_upload(blob_id, bytes, media_type)),
                RoundOperation::Sync { request, realtime } => RoundReply::Sync(if realtime {
                    transport.realtime_sync(request)
                } else {
                    transport.sync(request)
                }),
                RoundOperation::Downloads(fetches) => {
                    RoundReply::Downloads(transport.download_segments(fetches, &mut |_, _| {}))
                }
            };
            prepared
                .submit(reply)
                .expect("the driver answers the pending operation");
        }
        prepared.finish().expect("the round has no work left")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlobUploadGrant, SegmentRequest, SyncClient, TransportError};

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
    fn a_failed_presigned_put_falls_back_to_the_direct_endpoint() {
        let schema = serde_json::json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
        let mut client =
            SyncClient::new("spent-deadline".into(), &schema, Default::default()).unwrap();
        client.set_meta(crate::client::LOG_EPOCH_KEY, "epoch");
        client
            .upload_blob(b"body", Some("text/plain".into()), None)
            .unwrap();
        let mut prepared = client.prepare_sync_round(false).unwrap();
        let mut transport = SpentDeadline;
        let mut steps = Vec::new();
        while let Some(operation) = prepared.next_operation() {
            let reply = match operation {
                RoundOperation::UploadGrant {
                    blob_id,
                    byte_length,
                    media_type,
                } => {
                    steps.push("grant");
                    RoundReply::UploadGrant(transport.blob_upload_grant(
                        blob_id,
                        byte_length,
                        media_type,
                    ))
                }
                RoundOperation::UploadPut {
                    url,
                    bytes,
                    media_type,
                } => {
                    steps.push("put");
                    RoundReply::Upload(transport.blob_put_url(url, bytes, media_type))
                }
                RoundOperation::Upload {
                    blob_id,
                    bytes,
                    media_type,
                } => {
                    steps.push("direct");
                    RoundReply::Upload(transport.blob_upload(blob_id, bytes, media_type))
                }
                _ => panic!("only upload operations precede the round message"),
            };
            prepared.submit(reply).unwrap();
        }
        assert_eq!(steps, ["grant", "put", "direct"]);
        let outcome = match client.apply_sync_round(prepared.finish().unwrap()) {
            AppliedSyncRound::Complete { outcome, .. } => outcome,
            AppliedSyncRound::Continue(_) => panic!("an upload failure does not continue"),
        };
        match outcome {
            SyncOutcome::Failed { error_code, .. } => {
                assert_eq!(error_code, "transport.timeout")
            }
            other => panic!("expected a typed upload failure, got {other:?}"),
        }
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
