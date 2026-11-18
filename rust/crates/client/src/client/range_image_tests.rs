//! §5.3 range images, §5.6 applied-segment rule and the §5.3 client memory
//! bound, driven through whole rounds against a scripted server.
use super::*;
use serde_json::json;

fn client() -> SyncClient {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let client =
        SyncClient::new("range-images".into(), &schema, ClientLimits::default()).expect("client");
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client
}

/// One range image holding `ids`; returns its descriptor and body.
fn image(ids: &[String]) -> (Frame, Vec<u8>) {
    let path =
        std::env::temp_dir().join(format!("syncular-range-image-{}.db", uuid::Uuid::new_v4()));
    let image = Connection::open(&path).unwrap();
    image
        .execute_batch(
            "CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
             CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);",
        )
        .unwrap();
    for id in ids {
        image
            .execute("INSERT INTO tasks VALUES (?1, 'p1', 1)", [id])
            .unwrap();
    }
    image
        .execute(
            "INSERT INTO _syncular_segment VALUES (1, 'tasks', 1, 7, 'digest', ?1)",
            [ids.len()],
        )
        .unwrap();
    drop(image);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    let frame = Frame::SegmentRef {
        segment_id: format!("sha256:{}", bytes_to_hex(&Sha256::digest(&bytes))),
        media_type: MediaType::Sqlite,
        table: "tasks".into(),
        byte_length: bytes.len() as i64,
        row_count: ids.len() as i64,
        as_of_commit_seq: 7,
        scope_digest: "digest".into(),
        row_cursor: None,
        next_row_cursor: None,
        url: None,
        url_expires_at_ms: None,
    };
    (frame, bytes)
}

fn segment_id(frame: &Frame) -> String {
    let Frame::SegmentRef { segment_id, .. } = frame else {
        panic!("a segment descriptor")
    };
    segment_id.clone()
}

type Position = (i64, Option<String>);

/// Answers each pull by the (cursor, token) the unit presents; a unit that
/// presents no progress gets an empty live section.
struct RangeServer {
    unit: String,
    sections: BTreeMap<Position, (Vec<Frame>, Option<&'static str>)>,
    bodies: BTreeMap<String, Vec<u8>>,
    presented: Vec<Option<Position>>,
    downloads: Vec<String>,
    fail_once: Option<String>,
}

impl RangeServer {
    fn new(unit: &str) -> Self {
        RangeServer {
            unit: unit.to_owned(),
            sections: BTreeMap::new(),
            bodies: BTreeMap::new(),
            presented: Vec::new(),
            downloads: Vec::new(),
            fail_once: None,
        }
    }

    /// The section a pull at `position` receives: `images` of rows, then a
    /// `SUB_END` carrying `token`.
    fn section(&mut self, position: Position, images: &[&[&str]], token: Option<&'static str>) {
        let refs = images
            .iter()
            .map(|ids| {
                let (frame, bytes) =
                    image(&ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>());
                self.bodies.insert(segment_id(&frame), bytes);
                frame
            })
            .collect();
        self.sections.insert(position, (refs, token));
    }
}

impl Transport for RangeServer {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        let request = decode_message(request).unwrap();
        let position = request.frames.iter().find_map(|frame| match frame {
            Frame::Progress {
                id,
                cursor,
                bootstrap_state,
            } if *id == self.unit => Some((
                *cursor,
                bootstrap_state.as_ref().map(|token| token.0.clone()),
            )),
            _ => None,
        });
        self.presented.push(position.clone());
        let mut frames = vec![Frame::RespHeader {
            required_schema_version: None,
            latest_schema_version: None,
            log_epoch: "epoch-1".into(),
            reset_required: false,
        }];
        if let Some(position) = position {
            let (refs, token) = self.sections[&position].clone();
            frames.push(Frame::SubStart {
                id: self.unit.clone(),
                status: SubStatus::Active,
                reason_code: String::new(),
                bootstrap: true,
                fenced: Vec::new(),
            });
            frames.extend(refs);
            frames.push(Frame::SubEnd {
                next_cursor: 7,
                bootstrap_state: token.map(|token| RawJson(token.into())),
            });
        }
        frames.push(Frame::LiveStart {
            status: LiveStatus::Active,
            reason_code: String::new(),
        });
        frames.push(Frame::LiveEnd {
            through_seq: 7,
            echo_digest: None,
        });
        Ok(encode_message(&Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames,
        }))
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }

    fn download_segment(
        &mut self,
        request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        self.downloads.push(request.segment_id.clone());
        if self.fail_once.as_ref() == Some(&request.segment_id) {
            self.fail_once = None;
            return Err(TransportError::new("sync.transport_failed", "cut off"));
        }
        Ok(self.bodies[&request.segment_id].clone())
    }

    fn realtime_connect(&mut self, _client_id: &str) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

fn ids(client: &SyncClient) -> Vec<String> {
    client
        .query("SELECT id FROM tasks ORDER BY id", &[])
        .unwrap()
        .into_iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect()
}

fn ids_of(server: &RangeServer, position: &Position) -> Vec<String> {
    server.sections[position].0.iter().map(segment_id).collect()
}

#[test]
fn range_images_of_one_table_clear_once_across_responses() {
    let mut client = client();
    let unit = client
        .subscribe(UnitScopes::from([("project_id".into(), "p1".into())]))
        .unwrap();
    // A stale local row the first range's first-page clear removes.
    client
        .conn
        .execute(
            "INSERT INTO _syncular_base_tasks VALUES ('stale', 'p1', 1)",
            [],
        )
        .unwrap();
    client.rebuild_overlay().unwrap();
    let mut server = RangeServer::new(&unit);
    let resumed = (7, Some(r#"{"range":2}"#.to_owned()));
    server.section((-1, None), &[&["a", "b"], &["c"]], Some(r#"{"range":2}"#));
    server.section(resumed.clone(), &[&["d"], &["e", "f"]], None);

    let outcome = client.sync_until_idle(&mut server, None);

    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(ids(&client), ["a", "b", "c", "d", "e", "f"]);
    assert_eq!(
        server.presented[..2],
        [Some((-1, None)), Some(resumed.clone())]
    );
    let mut expected = ids_of(&server, &(-1, None));
    expected.extend(ids_of(&server, &resumed));
    assert_eq!(server.downloads, expected);
    assert!(applied_rows(&client.conn, &unit).unwrap().is_empty());
}

#[test]
fn a_batch_fetches_two_images_and_the_next_pull_skips_the_applied_ones() {
    let mut client = client();
    let unit = client
        .subscribe(UnitScopes::from([("project_id".into(), "p1".into())]))
        .unwrap();
    let mut server = RangeServer::new(&unit);
    server.section((-1, None), &[&["a"], &["b"], &["c"], &["d"], &["e"]], None);
    let images = ids_of(&server, &(-1, None));

    // Round 1: two images apply; the section stops before the third.
    let SyncOutcome::Ok(report) = client.sync(&mut server) else {
        panic!("the deferred round succeeds")
    };
    assert_eq!(report.bootstrapping, std::slice::from_ref(&unit));
    assert_eq!(server.downloads, images[..2]);
    assert_eq!(ids(&client), ["a", "b"]);
    let stored = client.unit(&unit).unwrap().unwrap();
    assert_eq!((stored.cursor, stored.bootstrap_state), (Some(-1), None));
    assert!(client.sync_needed());

    // The idle drive pulls the same position until the section completes.
    let outcome = client.sync_until_idle(&mut server, None);

    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(server.downloads, images, "each image downloads once");
    assert_eq!(
        server.presented[..3],
        [Some((-1, None)), Some((-1, None)), Some((-1, None))]
    );
    assert_eq!(server.presented[3..], [None]);
    assert_eq!(ids(&client), ["a", "b", "c", "d", "e"]);
    assert_eq!(client.unit(&unit).unwrap().unwrap().cursor, None);
    assert!(applied_rows(&client.conn, &unit).unwrap().is_empty());
}

#[test]
fn deferred_images_renew_the_round_budget() {
    let mut client = client();
    let unit = client
        .subscribe(UnitScopes::from([("project_id".into(), "p1".into())]))
        .unwrap();
    let mut server = RangeServer::new(&unit);
    let rows: Vec<String> = (0..50).map(|n| format!("r{n:02}")).collect();
    let images: Vec<[&str; 1]> = rows.iter().map(|id| [id.as_str()]).collect();
    let images: Vec<&[&str]> = images.iter().map(|ids| ids.as_slice()).collect();
    server.section((-1, None), &images, None);

    // 25 deferring rounds exceed the default 20-round budget.
    let outcome = client.sync_until_idle(&mut server, None);

    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(ids(&client), rows);
    assert_eq!(server.downloads.len(), 50);
}

#[test]
fn a_failed_download_repeats_only_that_image_and_the_ones_after_it() {
    let mut client = client();
    let unit = client
        .subscribe(UnitScopes::from([("project_id".into(), "p1".into())]))
        .unwrap();
    let mut server = RangeServer::new(&unit);
    server.section((-1, None), &[&["a"], &["b"], &["c"]], None);
    let images = ids_of(&server, &(-1, None));
    server.fail_once = Some(images[1].clone());

    let outcome = client.sync(&mut server);

    assert!(
        matches!(&outcome, SyncOutcome::Failed { error_code, .. } if error_code == "sync.transport_failed"),
        "{outcome:?}"
    );
    assert_eq!(ids(&client), ["a"]);

    let outcome = client.sync_until_idle(&mut server, None);

    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(
        server.downloads,
        [&*images[0], &*images[1], &*images[1], &*images[2]]
    );
    assert_eq!(ids(&client), ["a", "b", "c"]);
}

#[test]
fn the_record_ends_when_the_presented_token_changes() {
    let mut client = client();
    let unit = client
        .subscribe(UnitScopes::from([("project_id".into(), "p1".into())]))
        .unwrap();
    let mut server = RangeServer::new(&unit);
    server.section((-1, None), &[&["a"], &["b"], &["c"]], None);
    let SyncOutcome::Ok(_) = client.sync(&mut server) else {
        panic!("the deferred round succeeds")
    };
    let record = applied_rows(&client.conn, &unit).unwrap();
    assert_eq!(record.values().collect::<Vec<_>>(), [&1, &1]);

    // §4.6: a reset re-arms the unit; the next pull presents another position
    // and downloads every image again.
    let stored = client.unit(&unit).unwrap().unwrap();
    save_unit(
        &client.conn,
        &UnitRecord {
            cursor: Some(3),
            bootstrap_state: Some(r#"{"restart":1}"#.to_owned()),
            ..stored
        },
    )
    .unwrap();
    assert!(applied_rows(&client.conn, &unit).unwrap().is_empty());
    let restarted = (3, Some(r#"{"restart":1}"#.to_owned()));
    server
        .sections
        .insert(restarted.clone(), server.sections[&(-1, None)].clone());
    server.downloads.clear();
    let SyncOutcome::Ok(_) = client.sync(&mut server) else {
        panic!("the round succeeds")
    };
    assert_eq!(server.presented.last(), Some(&Some(restarted)));
    assert_eq!(server.downloads, ids_of(&server, &(-1, None))[..2]);
}

#[test]
fn a_round_cut_between_the_chunks_of_a_range_resumes_after_them_in_a_new_client() {
    let path = std::env::temp_dir().join(format!("syncular-range-cut-{}.db", uuid::Uuid::new_v4()));
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let open = || {
        SyncClient::open_path(
            "range-cut".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap()
    };
    let mut client = open();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let unit = client
        .subscribe(UnitScopes::from([("project_id".into(), "p1".into())]))
        .unwrap();
    let rows: Vec<String> = (0..3000).map(|n| format!("t{n:04}")).collect();
    let mut server = RangeServer::new(&unit);
    let row_refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    server.section((-1, None), &[&row_refs], None);
    let image = ids_of(&server, &(-1, None)).remove(0);
    // A table's first chunk holds 1,024 rows; the next one is cut.
    client
        .conn
        .execute_batch(
            "CREATE TRIGGER cut_import BEFORE INSERT ON tasks WHEN (SELECT count(*) FROM tasks)>=1024
             BEGIN SELECT RAISE(ABORT,'cut'); END",
        )
        .unwrap();

    let outcome = client.sync(&mut server);

    assert!(matches!(outcome, SyncOutcome::Failed { .. }), "{outcome:?}");
    assert_eq!(ids(&client).len(), 1024);
    assert_eq!(
        applied_rows(&client.conn, &unit).unwrap(),
        BTreeMap::from([(image.clone(), 1024)])
    );
    client
        .conn
        .execute_batch("DROP TRIGGER cut_import")
        .unwrap();
    drop(client);

    let mut client = open();
    let outcome = client.sync_until_idle(&mut server, None);

    let SyncOutcome::Ok(report) = outcome else {
        panic!("the resumed drive succeeds: {outcome:?}")
    };
    assert_eq!(report.segment_rows_applied, 3000 - 1024);
    assert_eq!(server.downloads, [&*image, &*image]);
    assert_eq!(ids(&client), rows);
    assert!(applied_rows(&client.conn, &unit).unwrap().is_empty());
    drop(client);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_units_table_without_the_applied_record_gains_it_on_open() {
    let path = std::env::temp_dir().join(format!("syncular-units-{}.db", uuid::Uuid::new_v4()));
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE _syncular_units (id TEXT PRIMARY KEY, scopes TEXT NOT NULL,
               explicit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
               reason_code TEXT, cursor INTEGER DEFAULT -1, bootstrap_state TEXT,
               seeded TEXT NOT NULL DEFAULT '[]', echo TEXT);
             INSERT INTO _syncular_units(id, scopes) VALUES ('u', '{}');",
        )
        .unwrap();
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let client = SyncClient::open_path(
        "units".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .unwrap();

    record_applied_rows(&client.conn, "u", "sha256:a", 3).unwrap();

    assert_eq!(
        applied_rows(&client.conn, "u").unwrap(),
        BTreeMap::from([("sha256:a".to_owned(), 3)])
    );
    drop(client);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}
