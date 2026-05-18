package dev.syncular.client;

import java.util.concurrent.atomic.AtomicBoolean;

public final class SyncularBoltClient implements AutoCloseable {
    private final long handle;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    @FunctionalInterface
    public interface SyncularEventJsonListener {
        void onEventJson(String eventJson);
    }

    private SyncularBoltClient(long handle) {
        this.handle = handle;
    }

    public SyncularBoltClient(SyncularBoltClientConfig config) {
        this(SyncularBoltClient.createHandle0(config));
    }

    private static long createHandle0(SyncularBoltClientConfig config) {
        try (
            WireWriter _wire_config = new WireWriter(config.wireEncodedSize())
        ) {
            config.wireEncodeTo(_wire_config);
            long _handle = Native.boltffi_syncular_bolt_client_open(_wire_config.toBuffer());
            if (_handle == 0L) throw new RuntimeException("Constructor failed");
            return _handle;
        }
    }

    long rawHandle() {
        return handle;
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        Native.boltffi_syncular_bolt_client_free(handle);
    }

    public static SyncularBoltClient openAsync(SyncularBoltClientConfig config) {
        try (
            WireWriter _wire_config = new WireWriter(config.wireEncodedSize())
        ) {
            config.wireEncodeTo(_wire_config);
            long _handle = Native.boltffi_syncular_bolt_client_open_async(_wire_config.toBuffer());
            if (_handle == 0L) throw new RuntimeException("Factory constructor failed");
            return new SyncularBoltClient(_handle);
        }
    }

    public java.util.Optional<String> openCommandId() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_open_command_id(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readI8() == 0 ? java.util.Optional.empty() : java.util.Optional.ofNullable(reader.readString());
    }

    public boolean isOpenFinished() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_is_open_finished(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean finishOpenTimeout(long timeoutMs) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_finish_open_timeout(handle, timeoutMs);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public String runtimeManifestJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_runtime_manifest_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public boolean setAuthHeadersJson(String headersJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_set_auth_headers_json(handle, headersJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean setSubscriptionsJson(String subscriptionsJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_set_subscriptions_json(handle, subscriptionsJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean setFieldEncryptionJson(String configJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_set_field_encryption_json(handle, configJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean setEncryptedCrdtJson(String configJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_set_encrypted_crdt_json(handle, configJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean triggerSync() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_trigger_sync(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean triggerSyncWebsocket() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_trigger_sync_websocket(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public String enqueueSyncNow() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_sync_now(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String enqueueSyncWebsocket() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_sync_websocket(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public boolean pauseSyncWorker() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_pause_sync_worker(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean resumeSyncWorker() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_resume_sync_worker(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean syncWorkerRunning() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_sync_worker_running(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean startRealtimeWorker() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_start_realtime_worker(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean start() {
        return startRealtimeWorker();
    }

    public boolean stopRealtimeWorker() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_stop_realtime_worker(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public boolean stop() {
        return stopRealtimeWorker();
    }

    public boolean startEventStream(long capacity) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_start_event_stream(handle, capacity);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public java.util.Optional<String> nextEventJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_next_event_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readI8() == 0 ? java.util.Optional.empty() : java.util.Optional.ofNullable(reader.readString());
    }

    public boolean closeEventStream() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_close_event_stream(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public void forEachEventJson(long capacity, java.util.function.Predicate<String> handler) {
        startEventStream(capacity);
        try {
            while (true) {
                java.util.Optional<String> eventJson = nextEventJson();
                if (eventJson.isEmpty()) break;
                if (!handler.test(eventJson.get())) break;
            }
        } finally {
            closeEventStream();
        }
    }

    public void forEachEventJson(long capacity, SyncularEventJsonListener listener) {
        forEachEventJson(capacity, eventJson -> {
            listener.onEventJson(eventJson);
            return true;
        });
    }

    public String applyLocalOperationJson(String operationJson, java.util.Optional<String> localRowJson) {
        try (
            WireWriter _wire_local_row_json = new WireWriter((1 + ((localRowJson).isPresent() ? ((4 + (4 + ((localRowJson).get()).length() * 3))) : 0)))
        ) {
            if ((localRowJson).isPresent()) { _wire_local_row_json.writeI8((byte)1); _wire_local_row_json.writeString((localRowJson).get()); } else { _wire_local_row_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_apply_local_operation_json(handle, operationJson.getBytes(java.nio.charset.StandardCharsets.UTF_8), _wire_local_row_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public String enqueueLocalOperationJson(String operationJson, java.util.Optional<String> localRowJson) {
        try (
            WireWriter _wire_local_row_json = new WireWriter((1 + ((localRowJson).isPresent() ? ((4 + (4 + ((localRowJson).get()).length() * 3))) : 0)))
        ) {
            if ((localRowJson).isPresent()) { _wire_local_row_json.writeI8((byte)1); _wire_local_row_json.writeString((localRowJson).get()); } else { _wire_local_row_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_local_operation_json(handle, operationJson.getBytes(java.nio.charset.StandardCharsets.UTF_8), _wire_local_row_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public String applyMutationJson(String mutationJson, java.util.Optional<String> localRowJson) {
        try (
            WireWriter _wire_local_row_json = new WireWriter((1 + ((localRowJson).isPresent() ? ((4 + (4 + ((localRowJson).get()).length() * 3))) : 0)))
        ) {
            if ((localRowJson).isPresent()) { _wire_local_row_json.writeI8((byte)1); _wire_local_row_json.writeString((localRowJson).get()); } else { _wire_local_row_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_apply_mutation_json(handle, mutationJson.getBytes(java.nio.charset.StandardCharsets.UTF_8), _wire_local_row_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public String enqueueMutationJson(String mutationJson, java.util.Optional<String> localRowJson) {
        try (
            WireWriter _wire_local_row_json = new WireWriter((1 + ((localRowJson).isPresent() ? ((4 + (4 + ((localRowJson).get()).length() * 3))) : 0)))
        ) {
            if ((localRowJson).isPresent()) { _wire_local_row_json.writeI8((byte)1); _wire_local_row_json.writeString((localRowJson).get()); } else { _wire_local_row_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_mutation_json(handle, mutationJson.getBytes(java.nio.charset.StandardCharsets.UTF_8), _wire_local_row_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public String enqueueYjsUpdateJson(String updateJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_yjs_update_json(handle, updateJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String openCrdtFieldJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_open_crdt_field_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String applyCrdtFieldTextJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_apply_crdt_field_text_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String applyCrdtFieldYjsUpdateJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_apply_crdt_field_yjs_update_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String enqueueCrdtFieldYjsUpdateJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_crdt_field_yjs_update_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String enqueueCrdtFieldTextJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_crdt_field_text_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String enqueueCrdtFieldCompactionJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_crdt_field_compaction_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String materializeCrdtFieldJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_materialize_crdt_field_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String crdtDocumentSnapshotJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_crdt_document_snapshot_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String crdtUpdateLogJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_crdt_update_log_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String snapshotCrdtFieldStateVectorJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_snapshot_crdt_field_state_vector_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String compactCrdtFieldJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_compact_crdt_field_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String applyEncryptedCrdtUpdateJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_apply_encrypted_crdt_update_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String enqueueEncryptedCrdtUpdateJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_encrypted_crdt_update_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String applyEncryptedCrdtCheckpointJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_apply_encrypted_crdt_checkpoint_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String enqueueEncryptedCrdtCheckpointJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_encrypted_crdt_checkpoint_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String listTableJson(String table) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_list_table_json(handle, table.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String queryJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_query_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String enqueueRefreshSnapshotJson(String requestJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_refresh_snapshot_json(handle, requestJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String storeBlobFileJson(String path, java.util.Optional<String> optionsJson) {
        try (
            WireWriter _wire_options_json = new WireWriter((1 + ((optionsJson).isPresent() ? ((4 + (4 + ((optionsJson).get()).length() * 3))) : 0)))
        ) {
            if ((optionsJson).isPresent()) { _wire_options_json.writeI8((byte)1); _wire_options_json.writeString((optionsJson).get()); } else { _wire_options_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_store_blob_file_json(handle, path.getBytes(java.nio.charset.StandardCharsets.UTF_8), _wire_options_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public String enqueueStoreBlobFileJson(String path, java.util.Optional<String> optionsJson) {
        try (
            WireWriter _wire_options_json = new WireWriter((1 + ((optionsJson).isPresent() ? ((4 + (4 + ((optionsJson).get()).length() * 3))) : 0)))
        ) {
            if ((optionsJson).isPresent()) { _wire_options_json.writeI8((byte)1); _wire_options_json.writeString((optionsJson).get()); } else { _wire_options_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_store_blob_file_json(handle, path.getBytes(java.nio.charset.StandardCharsets.UTF_8), _wire_options_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public boolean retrieveBlobFileJson(String refJson, String path, java.util.Optional<String> optionsJson) {
        try (
            WireWriter _wire_options_json = new WireWriter((1 + ((optionsJson).isPresent() ? ((4 + (4 + ((optionsJson).get()).length() * 3))) : 0)))
        ) {
            if ((optionsJson).isPresent()) { _wire_options_json.writeI8((byte)1); _wire_options_json.writeString((optionsJson).get()); } else { _wire_options_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_retrieve_blob_file_json(handle, refJson.getBytes(java.nio.charset.StandardCharsets.UTF_8), path.getBytes(java.nio.charset.StandardCharsets.UTF_8), _wire_options_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readBool();
        }
    }

    public String enqueueRetrieveBlobFileJson(String refJson, String path, java.util.Optional<String> optionsJson) {
        try (
            WireWriter _wire_options_json = new WireWriter((1 + ((optionsJson).isPresent() ? ((4 + (4 + ((optionsJson).get()).length() * 3))) : 0)))
        ) {
            if ((optionsJson).isPresent()) { _wire_options_json.writeI8((byte)1); _wire_options_json.writeString((optionsJson).get()); } else { _wire_options_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_retrieve_blob_file_json(handle, refJson.getBytes(java.nio.charset.StandardCharsets.UTF_8), path.getBytes(java.nio.charset.StandardCharsets.UTF_8), _wire_options_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public boolean isBlobLocal(String hash) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_is_blob_local(handle, hash.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public String processBlobUploadQueueJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_process_blob_upload_queue_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String blobUploadQueueStatsJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_blob_upload_queue_stats_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String blobCacheStatsJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_blob_cache_stats_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public long pruneBlobCache(long maxBytes) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_prune_blob_cache(handle, maxBytes);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readI64();
    }

    public String enqueuePruneBlobCache(long maxBytes) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_prune_blob_cache(handle, maxBytes);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public boolean clearBlobCache() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_clear_blob_cache(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public String enqueueClearBlobCache() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_clear_blob_cache(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String compactStorageJson(java.util.Optional<String> optionsJson) {
        try (
            WireWriter _wire_options_json = new WireWriter((1 + ((optionsJson).isPresent() ? ((4 + (4 + ((optionsJson).get()).length() * 3))) : 0)))
        ) {
            if ((optionsJson).isPresent()) { _wire_options_json.writeI8((byte)1); _wire_options_json.writeString((optionsJson).get()); } else { _wire_options_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_compact_storage_json(handle, _wire_options_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public String enqueueCompactStorageJson(java.util.Optional<String> optionsJson) {
        try (
            WireWriter _wire_options_json = new WireWriter((1 + ((optionsJson).isPresent() ? ((4 + (4 + ((optionsJson).get()).length() * 3))) : 0)))
        ) {
            if ((optionsJson).isPresent()) { _wire_options_json.writeI8((byte)1); _wire_options_json.writeString((optionsJson).get()); } else { _wire_options_json.writeI8((byte)0); };
            byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_compact_storage_json(handle, _wire_options_json.toBuffer());
            if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
            WireReader reader = new WireReader(_buf);
            if (reader.readI8() != 0) {
                throw new RuntimeException(reader.readString());
            }
            return reader.readString();
        }
    }

    public String appTablesJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_app_tables_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String appTableMetadataJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_app_table_metadata_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String registerQueryJson(String queryJson) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_register_query_json(handle, queryJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public boolean unregisterQuery(String id) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_unregister_query(handle, id.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public String observedQueriesJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_observed_queries_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String outboxSummariesJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_outbox_summaries_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String conflictSummariesJson() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_conflict_summaries_json(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public boolean resolveConflict(String id, String resolution) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_resolve_conflict(handle, id.getBytes(java.nio.charset.StandardCharsets.UTF_8), resolution.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }

    public String enqueueResolveConflict(String id, String resolution) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_enqueue_resolve_conflict(handle, id.getBytes(java.nio.charset.StandardCharsets.UTF_8), resolution.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public String retryConflictKeepLocal(String id) {
        byte[] _buf = Native.boltffi_syncular_bolt_client_retry_conflict_keep_local(handle, id.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readString();
    }

    public boolean shutdown() {
        byte[] _buf = Native.boltffi_syncular_bolt_client_shutdown(handle);
        if (_buf == null) throw new RuntimeException("FFI call returned null buffer");
        WireReader reader = new WireReader(_buf);
        if (reader.readI8() != 0) {
            throw new RuntimeException(reader.readString());
        }
        return reader.readBool();
    }
}
