use crate::error::{ErrorKind, Result, SyncularError};
use crate::generated::{AppTableMetadata, APP_TABLE_METADATA};
use crate::store::now_ms;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct StorageCompactionOptions {
    pub older_than_ms: Option<i64>,
    pub max_blob_cache_bytes: Option<i64>,
    pub prune_acked_outbox: Option<bool>,
    pub prune_resolved_conflicts: Option<bool>,
    pub prune_failed_blob_uploads: Option<bool>,
    pub prune_inactive_subscription_states: Option<bool>,
    pub prune_tombstones: Option<bool>,
    pub max_tombstone_server_version: Option<i64>,
    pub prune_encrypted_crdt_updates: Option<bool>,
    pub max_encrypted_crdt_checkpoints_per_stream: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageCompactionReport {
    pub acked_outbox_commits_deleted: i64,
    pub resolved_conflicts_deleted: i64,
    pub failed_blob_uploads_deleted: i64,
    pub inactive_subscription_states_deleted: i64,
    pub tombstone_rows_deleted: i64,
    pub blob_cache_bytes_pruned: i64,
    pub encrypted_crdt_updates_deleted: i64,
    pub encrypted_crdt_checkpoints_deleted: i64,
}

impl StorageCompactionOptions {
    pub fn from_json(options_json: Option<&str>) -> Result<Self> {
        match options_json.map(str::trim) {
            None | Some("") => Ok(Self::default()),
            Some(value) => serde_json::from_str(value).map_err(SyncularError::protocol),
        }
    }

    pub fn cutoff_ms(&self, now: i64) -> Result<Option<i64>> {
        let Some(age) = self.older_than_ms else {
            return Ok(None);
        };
        if age < 0 {
            return Err(SyncularError::message(
                ErrorKind::Config,
                "storage compaction olderThanMs must be non-negative",
            ));
        }
        Ok(Some(now.saturating_sub(age)))
    }

    pub fn cutoff_ms_now(&self) -> Result<Option<i64>> {
        self.cutoff_ms(now_ms())
    }

    pub fn should_prune_acked_outbox(&self) -> bool {
        self.prune_acked_outbox
            .unwrap_or(self.older_than_ms.is_some())
    }

    pub fn should_prune_resolved_conflicts(&self) -> bool {
        self.prune_resolved_conflicts
            .unwrap_or(self.older_than_ms.is_some())
    }

    pub fn should_prune_failed_blob_uploads(&self) -> bool {
        self.prune_failed_blob_uploads.unwrap_or(false)
    }

    pub fn should_prune_inactive_subscription_states(&self) -> bool {
        self.prune_inactive_subscription_states.unwrap_or(false)
    }

    pub fn should_prune_tombstones(&self) -> bool {
        self.prune_tombstones
            .unwrap_or(self.max_tombstone_server_version.is_some())
    }

    pub fn should_prune_encrypted_crdt_updates(&self) -> bool {
        self.prune_encrypted_crdt_updates.unwrap_or(false)
    }

    pub fn encrypted_crdt_checkpoint_keep_count(&self) -> Result<Option<i64>> {
        let Some(count) = self.max_encrypted_crdt_checkpoints_per_stream else {
            return Ok(None);
        };
        if count < 1 {
            return Err(SyncularError::message(
                ErrorKind::Config,
                "storage compaction maxEncryptedCrdtCheckpointsPerStream must be at least 1",
            ));
        }
        Ok(Some(count))
    }
}

pub fn tombstone_delete_statements(max_server_version: i64) -> Result<Vec<String>> {
    APP_TABLE_METADATA
        .iter()
        .filter_map(|metadata| {
            metadata
                .soft_delete_column
                .map(|soft_delete_column| (metadata, soft_delete_column))
        })
        .map(|(metadata, soft_delete_column)| {
            tombstone_delete_statement(metadata, soft_delete_column, max_server_version)
        })
        .collect()
}

pub fn tombstone_table_names() -> Vec<String> {
    APP_TABLE_METADATA
        .iter()
        .filter(|metadata| metadata.soft_delete_column.is_some())
        .map(|metadata| metadata.name.to_string())
        .collect()
}

pub fn required_compaction_cutoff(cutoff: Option<i64>, label: &str) -> Result<i64> {
    cutoff.ok_or_else(|| {
        SyncularError::config(format!(
            "storage compaction for {label} requires olderThanMs"
        ))
    })
}

fn tombstone_delete_statement(
    metadata: &AppTableMetadata,
    soft_delete_column: &str,
    max_server_version: i64,
) -> Result<String> {
    validate_sqlite_identifier(metadata.name)?;
    validate_sqlite_identifier(soft_delete_column)?;
    validate_sqlite_identifier(metadata.server_version_column)?;
    Ok(format!(
        "delete from {table} where {soft_delete_column} != 0 and {server_version_column} <= {max_server_version}",
        table = metadata.name,
        server_version_column = metadata.server_version_column,
    ))
}

fn validate_sqlite_identifier(identifier: &str) -> Result<()> {
    if identifier
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        Ok(())
    } else {
        Err(SyncularError::schema(format!(
            "invalid sqlite identifier in storage compaction: {identifier}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn age_cutoff_enables_safe_default_cleanup() -> Result<()> {
        let options = StorageCompactionOptions {
            older_than_ms: Some(1_000),
            ..StorageCompactionOptions::default()
        };

        assert_eq!(options.cutoff_ms(10_000)?, Some(9_000));
        assert!(options.should_prune_acked_outbox());
        assert!(options.should_prune_resolved_conflicts());
        assert!(!options.should_prune_failed_blob_uploads());
        assert!(!options.should_prune_inactive_subscription_states());
        assert!(!options.should_prune_tombstones());
        assert!(!options.should_prune_encrypted_crdt_updates());
        Ok(())
    }

    #[test]
    fn tombstone_cleanup_requires_server_version_bound() {
        let options = StorageCompactionOptions {
            max_tombstone_server_version: Some(42),
            ..StorageCompactionOptions::default()
        };

        assert!(options.should_prune_tombstones());
        let statements = tombstone_delete_statements(42).expect("statements");
        assert!(statements
            .iter()
            .any(|statement| statement.contains("delete from comments")));
        assert!(statements
            .iter()
            .all(|statement| statement.contains("server_version <= 42")));
    }
}
