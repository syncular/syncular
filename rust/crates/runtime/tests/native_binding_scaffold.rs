#[test]
fn boltffi_config_is_the_native_binding_contract() {
    let config = include_str!("../boltffi.toml");

    assert!(config.contains("name = \"syncular\""));
    assert!(config.contains("crate = \"syncular-runtime\""));
    assert!(config.contains("output = \"../../bindings/swift\""));
    assert!(config.contains("module_name = \"Syncular\""));
    assert!(config.contains("output = \"../../bindings/swift/Sources/BoltFFI\""));
    assert!(config.contains("output = \"../../bindings/kotlin\""));
    assert!(config.contains("architectures = [\"arm64\", \"x86_64\"]"));
    assert!(config.contains("package = \"dev.syncular.client\""));
    assert!(config.contains("output = \"../../bindings/java\""));
    assert!(config.contains("enabled = false"));
    assert!(config.contains("rust/bindings/browser"));
}

#[test]
fn boltffi_rust_surface_exposes_the_syncular_runtime_boundary() {
    let source = include_str!("../src/bindings/boltffi.rs");

    assert!(source.contains("pub struct SyncularBoltClientConfig"));
    assert!(source.contains("pub struct SyncularBoltClient"));
    assert!(source.contains("pub fn syncular_runtime_manifest_json"));
    assert!(source.contains("pub fn syncular_take_last_open_error"));
    assert!(source.contains("pub fn open(config: SyncularBoltClientConfig)"));
    assert!(source.contains(
        "pub fn set_auth_headers_json(&self, headers_json: &str) -> Result<bool, String>"
    ));
    assert!(source.contains("pub fn force_subscriptions_bootstrap_json"));
    assert!(source.contains("pub fn syncular_encryption_helper_json"));
    assert!(source.contains("pub fn set_field_encryption_json"));
    assert!(source.contains("pub fn set_encrypted_crdt_json"));
    assert!(source.contains("pub fn trigger_sync(&self) -> Result<bool, String>"));
    assert!(source.contains("pub fn enqueue_sync_now"));
    assert!(source.contains("pub fn apply_mutation_json"));
    assert!(source.contains("pub fn enqueue_mutation_json"));
    assert!(!source.contains("pub fn apply_local_operation_json"));
    assert!(!source.contains("pub fn enqueue_local_operation_json"));
    assert!(source.contains("pub fn enqueue_yjs_update_json"));
    assert!(source.contains("pub fn open_crdt_field_json"));
    assert!(source.contains("pub fn apply_crdt_field_text_json"));
    assert!(source.contains("pub fn apply_crdt_field_yjs_update_json"));
    assert!(source.contains("pub fn enqueue_crdt_field_yjs_update_json"));
    assert!(source.contains("pub fn enqueue_crdt_field_text_json"));
    assert!(source.contains("pub fn enqueue_crdt_field_compaction_json"));
    assert!(source.contains("pub fn materialize_crdt_field_json"));
    assert!(source.contains("pub fn snapshot_crdt_field_state_vector_json"));
    assert!(source.contains("pub fn compact_crdt_field_json"));
    assert!(source.contains("pub fn apply_encrypted_crdt_update_json"));
    assert!(source.contains("pub fn enqueue_encrypted_crdt_update_json"));
    assert!(source.contains("pub fn apply_encrypted_crdt_checkpoint_json"));
    assert!(source.contains("pub fn enqueue_encrypted_crdt_checkpoint_json"));
    assert!(source.contains("pub fn list_table_json"));
    assert!(source.contains("pub fn query_json"));
    assert!(source.contains("pub fn enqueue_refresh_snapshot_json"));
    assert!(source.contains("pub fn store_blob_file_json"));
    assert!(source.contains("pub fn enqueue_store_blob_file_json"));
    assert!(source.contains("pub fn retrieve_blob_file_json"));
    assert!(source.contains("pub fn enqueue_retrieve_blob_file_json"));
    assert!(source.contains("pub fn compact_storage_json"));
    assert!(source.contains("pub fn enqueue_compact_storage_json"));
    assert!(source.contains("pub fn app_schema_state_json"));
    assert!(source.contains("pub fn register_query_json"));
    assert!(source.contains("pub fn diagnostic_snapshot_json"));
    assert!(source.contains("pub fn enqueue_resolve_conflict"));
    assert!(source.contains("pub fn start_event_stream"));
    assert!(source.contains("pub fn next_event_json"));
    assert!(source.contains("pub fn close_event_stream"));
    assert!(source.contains("pub fn shutdown"));
    assert!(!source.contains("uniffi"));
}

#[test]
fn generated_boltffi_native_outputs_cover_current_surface() {
    let swift =
        include_str!("../../../bindings/swift/Sources/BoltFFI/Syncular-runtimeBoltFFI.swift");
    let kotlin = include_str!("../../../bindings/kotlin/kotlin/dev/syncular/client/Syncular.kt");
    let java = include_str!("../../../bindings/java/dev/syncular/client/SyncularBoltClient.java");
    let java_helpers = include_str!("../../../bindings/java/dev/syncular/client/Syncular.java");
    let android_header = include_str!("../../../bindings/kotlin/include/syncular-runtime.h");
    let java_header = include_str!("../../../bindings/java/jni/syncular_runtime.h");

    assert!(swift.contains("public final class SyncularBoltClient"));
    assert!(swift.contains("public func syncularTakeLastOpenError"));
    assert!(swift.contains("func setAuthHeadersJson(headersJson: String) throws -> Bool"));
    assert!(swift.contains(
        "func forceSubscriptionsBootstrapJson(subscriptionIdsJson: String) throws -> String"
    ));
    assert!(swift.contains("func setFieldEncryptionJson(configJson: String) throws -> Bool"));
    assert!(swift.contains("func setEncryptedCrdtJson(configJson: String) throws -> Bool"));
    assert!(swift.contains("public func syncularEncryptionHelperJson"));
    assert!(swift.contains(
        "func applyMutationJson(mutationJson: String, localRowJson: String?) throws -> String"
    ));
    assert!(swift.contains(
        "func enqueueMutationJson(mutationJson: String, localRowJson: String?) throws -> String"
    ));
    assert!(swift.contains("func enqueueYjsUpdateJson(updateJson: String) throws -> String"));
    assert!(swift.contains("func openCrdtFieldJson(requestJson: String) throws -> String"));
    assert!(swift.contains("func applyCrdtFieldTextJson(requestJson: String) throws -> String"));
    assert!(
        swift.contains("func applyCrdtFieldYjsUpdateJson(requestJson: String) throws -> String")
    );
    assert!(
        swift.contains("func enqueueCrdtFieldYjsUpdateJson(requestJson: String) throws -> String")
    );
    assert!(swift.contains("func materializeCrdtFieldJson(requestJson: String) throws -> String"));
    assert!(swift
        .contains("func snapshotCrdtFieldStateVectorJson(requestJson: String) throws -> String"));
    assert!(swift.contains("func compactCrdtFieldJson(requestJson: String) throws -> String"));
    assert!(
        swift.contains("func applyEncryptedCrdtUpdateJson(requestJson: String) throws -> String")
    );
    assert!(
        swift.contains("func enqueueEncryptedCrdtUpdateJson(requestJson: String) throws -> String")
    );
    assert!(swift
        .contains("func applyEncryptedCrdtCheckpointJson(requestJson: String) throws -> String"));
    assert!(swift
        .contains("func enqueueEncryptedCrdtCheckpointJson(requestJson: String) throws -> String"));
    assert!(swift.contains("func enqueueRefreshSnapshotJson(requestJson: String) throws -> String"));
    assert!(swift.contains(
        "func enqueueStoreBlobFileJson(path: String, optionsJson: String?) throws -> String"
    ));
    assert!(swift.contains("func queryJson(requestJson: String) throws -> String"));
    assert!(swift.contains("func startEventStream(capacity: UInt64) throws -> Bool"));
    assert!(swift.contains("func nextEventJson() throws -> String?"));
    assert!(swift.contains("func nextEventJsonTimeout(timeoutMs: UInt64) throws -> String?"));
    assert!(swift.contains("func closeEventStream() throws -> Bool"));
    assert!(swift.contains("func diagnosticSnapshotJson() throws -> String"));
    assert!(swift.contains("func appSchemaStateJson() throws -> String"));
    assert!(swift.contains("func shutdown() throws -> Bool"));
    assert!(kotlin.contains("class SyncularBoltClient"));
    assert!(kotlin.contains("fun syncularTakeLastOpenError(): String?"));
    assert!(kotlin.contains("fun setAuthHeadersJson(headersJson: String): Boolean"));
    assert!(
        kotlin.contains("fun forceSubscriptionsBootstrapJson(subscriptionIdsJson: String): String")
    );
    assert!(kotlin.contains("fun setFieldEncryptionJson(configJson: String): Boolean"));
    assert!(kotlin.contains("fun setEncryptedCrdtJson(configJson: String): Boolean"));
    assert!(kotlin.contains("fun syncularEncryptionHelperJson"));
    assert!(kotlin
        .contains("fun applyMutationJson(mutationJson: String, localRowJson: String?): String"));
    assert!(kotlin
        .contains("fun enqueueMutationJson(mutationJson: String, localRowJson: String?): String"));
    assert!(kotlin.contains("fun enqueueYjsUpdateJson(updateJson: String): String"));
    assert!(kotlin.contains("fun openCrdtFieldJson(requestJson: String): String"));
    assert!(kotlin.contains("fun applyCrdtFieldTextJson(requestJson: String): String"));
    assert!(kotlin.contains("fun applyCrdtFieldYjsUpdateJson(requestJson: String): String"));
    assert!(kotlin.contains("fun enqueueCrdtFieldYjsUpdateJson(requestJson: String): String"));
    assert!(kotlin.contains("fun materializeCrdtFieldJson(requestJson: String): String"));
    assert!(kotlin.contains("fun snapshotCrdtFieldStateVectorJson(requestJson: String): String"));
    assert!(kotlin.contains("fun compactCrdtFieldJson(requestJson: String): String"));
    assert!(kotlin.contains("fun applyEncryptedCrdtUpdateJson(requestJson: String): String"));
    assert!(kotlin.contains("fun enqueueEncryptedCrdtUpdateJson(requestJson: String): String"));
    assert!(kotlin.contains("fun applyEncryptedCrdtCheckpointJson(requestJson: String): String"));
    assert!(kotlin.contains("fun enqueueEncryptedCrdtCheckpointJson(requestJson: String): String"));
    assert!(kotlin.contains("fun enqueueRefreshSnapshotJson(requestJson: String): String"));
    assert!(
        kotlin.contains("fun enqueueStoreBlobFileJson(path: String, optionsJson: String?): String")
    );
    assert!(kotlin.contains("fun queryJson(requestJson: String): String"));
    assert!(kotlin.contains("fun startEventStream(capacity: ULong): Boolean"));
    assert!(kotlin.contains("fun nextEventJson(): String?"));
    assert!(kotlin.contains("fun nextEventJsonTimeout(timeoutMs: ULong): String?"));
    assert!(kotlin.contains("fun closeEventStream(): Boolean"));
    assert!(kotlin.contains("fun diagnosticSnapshotJson(): String"));
    assert!(kotlin.contains("fun appSchemaStateJson(): String"));
    assert!(kotlin.contains("fun shutdown(): Boolean"));
    assert!(!kotlin.contains("fun close(): Boolean"));
    assert!(!kotlin.contains("1.toInt()"));
    assert!(java.contains("public final class SyncularBoltClient"));
    assert!(java.contains("public boolean setAuthHeadersJson(String headersJson)"));
    assert!(
        java.contains("public String forceSubscriptionsBootstrapJson(String subscriptionIdsJson)")
    );
    assert!(java.contains("public boolean setFieldEncryptionJson(String configJson)"));
    assert!(java.contains("public boolean setEncryptedCrdtJson(String configJson)"));
    assert!(java_helpers.contains("public static String syncularEncryptionHelperJson"));
    assert!(java.contains(
        "public String applyMutationJson(String mutationJson, java.util.Optional<String> localRowJson)"
    ));
    assert!(java.contains(
        "public String enqueueMutationJson(String mutationJson, java.util.Optional<String> localRowJson)"
    ));
    assert!(java.contains("public String enqueueYjsUpdateJson(String updateJson)"));
    assert!(java.contains("public String openCrdtFieldJson(String requestJson)"));
    assert!(java.contains("public String applyCrdtFieldTextJson(String requestJson)"));
    assert!(java.contains("public String applyCrdtFieldYjsUpdateJson(String requestJson)"));
    assert!(java.contains("public String enqueueCrdtFieldYjsUpdateJson(String requestJson)"));
    assert!(java.contains("public String materializeCrdtFieldJson(String requestJson)"));
    assert!(java.contains("public String snapshotCrdtFieldStateVectorJson(String requestJson)"));
    assert!(java.contains("public String compactCrdtFieldJson(String requestJson)"));
    assert!(java.contains("public String applyEncryptedCrdtUpdateJson(String requestJson)"));
    assert!(java.contains("public String enqueueEncryptedCrdtUpdateJson(String requestJson)"));
    assert!(java.contains("public String applyEncryptedCrdtCheckpointJson(String requestJson)"));
    assert!(java.contains("public String enqueueEncryptedCrdtCheckpointJson(String requestJson)"));
    assert!(java.contains("public String enqueueRefreshSnapshotJson(String requestJson)"));
    assert!(java.contains(
        "public String enqueueStoreBlobFileJson(String path, java.util.Optional<String> optionsJson)"
    ));
    assert!(java.contains("public String queryJson(String requestJson)"));
    assert!(java.contains("public boolean startEventStream(long capacity)"));
    assert!(java.contains("public java.util.Optional<String> nextEventJson()"));
    assert!(java.contains("public java.util.Optional<String> nextEventJsonTimeout(long timeoutMs)"));
    assert!(java.contains("public boolean closeEventStream()"));
    assert!(java.contains("public String diagnosticSnapshotJson()"));
    assert!(java.contains("public String appSchemaStateJson()"));
    assert!(java.contains("public boolean shutdown()"));
    assert!(!java.contains("public boolean close()"));
    assert!(android_header.contains("boltffi_syncular_bolt_client_open"));
    assert!(java_header.contains("boltffi_syncular_bolt_client_open"));
    assert!(android_header.contains("boltffi_syncular_bolt_client_start_event_stream"));
    assert!(java_header.contains("boltffi_syncular_bolt_client_start_event_stream"));
    assert!(android_header.contains("boltffi_syncular_bolt_client_next_event_json_timeout"));
    assert!(java_header.contains("boltffi_syncular_bolt_client_next_event_json_timeout"));
    assert!(android_header.contains("boltffi_syncular_bolt_client_diagnostic_snapshot_json"));
    assert!(java_header.contains("boltffi_syncular_bolt_client_diagnostic_snapshot_json"));
    for output in [swift, kotlin, java] {
        assert!(!output.contains("tasks"));
        assert!(!output.contains("NewTask"));
        assert!(!output.contains("TaskPatch"));
        assert!(!output.contains("applyNewTask"));
        assert!(!output.contains("listTasks"));
    }
    assert!(!swift.contains("Uniffi"));
    assert!(!kotlin.contains("Uniffi"));
    assert!(!java.contains("Uniffi"));
}

#[test]
fn generated_app_bindings_target_boltffi_layout() {
    let swift = include_str!("../../../examples/todo-app/generated/swift/SyncularApp.swift");
    let kotlin = include_str!("../../../examples/todo-app/generated/kotlin/SyncularApp.kt");
    let android_kotlin =
        include_str!("../../../examples/todo-app/generated/kotlin/android/SyncularApp.kt");

    assert!(swift.contains("public protocol SyncularNativeJsonClient"));
    assert!(swift.contains("public struct SyncularReadonlyQuery"));
    assert!(swift.contains("public struct SyncularQueryColumn"));
    assert!(swift.contains("public struct SyncularSelectQuery"));
    assert!(swift.contains("public struct SyncularLiveQueryRegistration"));
    assert!(swift.contains("public struct SyncularChangedRow"));
    assert!(swift.contains("public struct TaskChangedRow"));
    assert!(swift.contains("public struct TaskChangedFields"));
    assert!(swift.contains("public struct SyncularNativeErrorInfo"));
    assert!(swift.contains("public struct SyncularNativeEvent"));
    assert!(swift.contains("public let error: SyncularNativeErrorInfo?"));
    assert!(swift.contains("public let recommendedAction: String"));
    assert!(swift.contains("public let changedRows: [SyncularChangedRow]"));
    assert!(swift.contains("public let droppedCount: UInt64?"));
    assert!(swift.contains("public let resyncRequired: Bool"));
    assert!(swift.contains("public func syncularNativeEventRequiresFullRefresh"));
    assert!(swift.contains("public func syncularDecodeNativeEvent"));
    assert!(swift.contains("public struct SyncularCrdtFieldDescriptor"));
    assert!(swift.contains("func openCrdtField(_ request: SyncularCrdtFieldRequest) throws -> SyncularCrdtFieldDescriptor"));
    assert!(swift.contains("public final class SyncularNativeLiveQuery"));
    assert!(swift.contains("func applyMutationJson(mutationJson: String"));
    assert!(swift.contains("try applyMutationJson(mutationJson: operation.jsonString()"));
    assert!(swift.contains("queryJson(requestJson: query.jsonString())"));
    assert!(swift.contains("func registerQueryJson(queryJson: String"));
    assert!(swift.contains("func unregisterQuery(id: String"));
    assert!(swift.contains("client.registerLiveQuery(SyncularLiveQueryRegistration"));
    assert!(swift.contains("rows = try client.query(query, as: rowType)"));
    assert!(swift.contains("public func refreshIfChanged(event: SyncularNativeEvent"));
    assert!(swift.contains("if syncularNativeEventRequiresFullRefresh(event)"));
    assert!(!swift.contains("func applyLocalOperationJson"));
    assert!(swift.contains("func queryJson(requestJson: String) throws -> String"));
    assert!(!swift.contains("func listTasks()"));
    assert!(!swift.contains("func listTableJson"));
    assert!(!swift.contains("storeBlobFileJson"));
    assert!(!swift.contains("triggerSync"));
    assert!(swift.contains("public enum TaskQuery"));
    assert!(swift.contains("public static func select() -> SyncularSelectQuery<TaskRow>"));
    assert!(!swift.contains("func applyNewTask(_ input: NewTask"));
    assert!(kotlin.contains("interface SyncularNativeJsonClient"));
    assert!(kotlin.contains("data class SyncularReadonlyQuery"));
    assert!(kotlin.contains("class SyncularQueryColumn"));
    assert!(kotlin.contains("data class SyncularSelectQuery"));
    assert!(kotlin.contains("data class SyncularLiveQueryRegistration"));
    assert!(kotlin.contains("data class SyncularChangedRow"));
    assert!(kotlin.contains("data class TaskChangedRow"));
    assert!(kotlin.contains("data class TaskChangedFields"));
    assert!(kotlin.contains("data class SyncularNativeErrorInfo"));
    assert!(kotlin.contains("data class SyncularNativeEvent"));
    assert!(kotlin.contains("val error: SyncularNativeErrorInfo? = null"));
    assert!(kotlin.contains("val recommendedAction: String"));
    assert!(kotlin.contains("val changedRows: List<SyncularChangedRow> = emptyList()"));
    assert!(kotlin.contains("val droppedCount: Long? = null"));
    assert!(kotlin.contains("val resyncRequired: Boolean = false"));
    assert!(kotlin.contains("fun syncularNativeEventRequiresFullRefresh"));
    assert!(kotlin.contains("fun syncularDecodeNativeEvent(eventJson: String)"));
    assert!(kotlin.contains("data class SyncularCrdtFieldDescriptor"));
    assert!(kotlin.contains("fun SyncularNativeJsonClient.openCrdtField(request: SyncularCrdtFieldRequest): SyncularCrdtFieldDescriptor"));
    assert!(kotlin.contains("class SyncularNativeLiveQuery<Row>"));
    assert!(kotlin.contains("fun applyMutationJson(mutationJson: String"));
    assert!(kotlin.contains("applyMutationJson(operation.toJsonString(), localRowJson)"));
    assert!(kotlin.contains("syncularGeneratedQueryRows(queryJson(query.toJsonString()))"));
    assert!(kotlin.contains("fun registerQueryJson(queryJson: String): String"));
    assert!(kotlin.contains("fun unregisterQuery(id: String): Boolean"));
    assert!(kotlin.contains("client.registerLiveQuery(SyncularLiveQueryRegistration"));
    assert!(kotlin.contains("rows = client.query(query, decode)"));
    assert!(kotlin.contains("fun refreshIfChanged(event: SyncularNativeEvent"));
    assert!(kotlin.contains("if (syncularNativeEventRequiresFullRefresh(event))"));
    assert!(!kotlin.contains("fun applyLocalOperationJson"));
    assert!(kotlin.contains("fun queryJson(requestJson: String): String"));
    assert!(!kotlin.contains("fun SyncularNativeJsonClient.listTasks()"));
    assert!(!kotlin.contains("fun listTableJson"));
    assert!(!kotlin.contains("storeBlobFileJson"));
    assert!(!kotlin.contains("triggerSync"));
    assert!(kotlin.contains("object TaskQuery"));
    assert!(kotlin.contains("fun select(): SyncularSelectQuery<TaskRow>"));
    assert!(!kotlin.contains("fun SyncularNativeJsonClient.applyNewTask(input: NewTask"));
    assert!(android_kotlin.contains("package dev.syncular.client.generated"));
    assert!(android_kotlin.contains("fun applyMutationJson(mutationJson: String"));
    assert!(android_kotlin.contains("applyMutationJson(operation.toJsonString(), localRowJson)"));
    assert!(android_kotlin.contains("syncularGeneratedQueryRows(queryJson(query.toJsonString()))"));
    assert!(android_kotlin.contains("data class SyncularLiveQueryRegistration"));
    assert!(android_kotlin.contains("data class SyncularChangedRow"));
    assert!(android_kotlin.contains("data class TaskChangedRow"));
    assert!(android_kotlin.contains("data class TaskChangedFields"));
    assert!(android_kotlin.contains("data class SyncularNativeErrorInfo"));
    assert!(android_kotlin.contains("data class SyncularNativeEvent"));
    assert!(android_kotlin.contains("val error: SyncularNativeErrorInfo? = null"));
    assert!(android_kotlin.contains("val changedRows: List<SyncularChangedRow> = emptyList()"));
    assert!(android_kotlin.contains("class SyncularNativeLiveQuery<Row>"));
    assert!(android_kotlin.contains("fun registerQueryJson(queryJson: String): String"));
    assert!(android_kotlin.contains("fun refreshIfChanged(event: SyncularNativeEvent"));
    assert!(android_kotlin.contains("fun queryJson(requestJson: String): String"));
    assert!(android_kotlin.contains("object TaskQuery"));
    assert!(android_kotlin.contains("fun select(): SyncularSelectQuery<TaskRow>"));
    assert!(!android_kotlin.contains("fun SyncularNativeJsonClient.listTasks()"));
    assert!(!android_kotlin.contains("storeBlobFileJson"));
    assert!(!android_kotlin.contains("triggerSync"));
    assert!(!swift.contains("TASKS_TABLE"));
    assert!(!kotlin.contains("TASKS_TABLE"));
    assert!(!android_kotlin.contains("TASKS_TABLE"));
}
