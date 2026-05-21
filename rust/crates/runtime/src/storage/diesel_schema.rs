diesel::table! {
    sync_auth_leases (lease_id) {
        lease_id -> Text,
        kid -> Text,
        actor_id -> Text,
        issued_at_ms -> BigInt,
        not_before_ms -> BigInt,
        expires_at_ms -> BigInt,
        schema_version -> Integer,
        payload_json -> Text,
        token -> Text,
        status -> Text,
        last_validation_error -> Nullable<Text>,
        created_at_ms -> BigInt,
        updated_at_ms -> BigInt,
    }
}

diesel::table! {
    sync_blob_cache (hash) {
        hash -> Text,
        size -> BigInt,
        mime_type -> Text,
        body -> Binary,
        encrypted -> Integer,
        key_id -> Nullable<Text>,
        cached_at -> BigInt,
        last_accessed_at -> BigInt,
    }
}

diesel::table! {
    sync_blob_outbox (id) {
        id -> Integer,
        hash -> Text,
        size -> BigInt,
        mime_type -> Text,
        body -> Binary,
        encrypted -> Integer,
        key_id -> Nullable<Text>,
        status -> Text,
        attempt_count -> Integer,
        error -> Nullable<Text>,
        created_at -> BigInt,
        updated_at -> BigInt,
        next_attempt_at -> BigInt,
    }
}

diesel::table! {
    sync_conflicts (id) {
        id -> Text,
        outbox_commit_id -> Text,
        client_commit_id -> Text,
        op_index -> Integer,
        result_status -> Text,
        message -> Text,
        code -> Nullable<Text>,
        server_version -> Nullable<BigInt>,
        server_row_json -> Nullable<Text>,
        created_at -> BigInt,
        resolved_at -> Nullable<BigInt>,
        resolution -> Nullable<Text>,
    }
}

diesel::table! {
    sync_crdt_checkpoints (seq) {
        seq -> Integer,
        partition_id -> Text,
        stream_id -> Text,
        app_table -> Text,
        row_id -> Text,
        field_name -> Text,
        checkpoint_id -> Text,
        covers_seq -> BigInt,
        actor_id -> Nullable<Text>,
        client_id -> Nullable<Text>,
        key_id -> Text,
        ciphertext -> Text,
        scopes -> Text,
        created_at -> BigInt,
        server_seq -> Nullable<BigInt>,
    }
}

diesel::table! {
    sync_crdt_updates (seq) {
        seq -> Integer,
        partition_id -> Text,
        stream_id -> Text,
        app_table -> Text,
        row_id -> Text,
        field_name -> Text,
        update_id -> Text,
        actor_id -> Nullable<Text>,
        client_id -> Nullable<Text>,
        key_id -> Text,
        ciphertext -> Text,
        scopes -> Text,
        created_at -> BigInt,
        server_seq -> Nullable<BigInt>,
    }
}

diesel::table! {
    sync_migrations (version) {
        version -> Text,
        name -> Text,
        checksum -> Text,
        applied_at -> BigInt,
    }
}

diesel::table! {
    sync_outbox_commits (id) {
        id -> Text,
        client_commit_id -> Text,
        status -> Text,
        operations_json -> Text,
        last_response_json -> Nullable<Text>,
        error -> Nullable<Text>,
        created_at -> BigInt,
        updated_at -> BigInt,
        attempt_count -> Integer,
        acked_commit_seq -> Nullable<BigInt>,
        schema_version -> Integer,
        next_attempt_at -> BigInt,
        lease_id -> Nullable<Text>,
        lease_expires_at_ms -> Nullable<BigInt>,
        lease_status_at_enqueue -> Nullable<Text>,
        lease_scope_summary_json -> Nullable<Text>,
    }
}

diesel::table! {
    sync_subscription_state (state_id, subscription_id) {
        state_id -> Text,
        subscription_id -> Text,
        #[sql_name = "table"]
        table_name -> Text,
        scopes_json -> Text,
        params_json -> Text,
        cursor -> BigInt,
        bootstrap_state_json -> Nullable<Text>,
        status -> Text,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::table! {
    sync_verified_roots (state_id, subscription_id) {
        state_id -> Text,
        subscription_id -> Text,
        partition_id -> Text,
        commit_seq -> BigInt,
        root -> Text,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::allow_tables_to_appear_in_same_query!(
    sync_auth_leases,
    sync_blob_cache,
    sync_blob_outbox,
    sync_conflicts,
    sync_crdt_checkpoints,
    sync_crdt_updates,
    sync_migrations,
    sync_outbox_commits,
    sync_subscription_state,
    sync_verified_roots,
);
