use crate::error::{Result, SyncularError};
use crate::protocol::MutationReceipt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandHistoryState {
    Done,
    Undone,
}

impl CommandHistoryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Undone => "undone",
        }
    }
}

impl TryFrom<&str> for CommandHistoryState {
    type Error = SyncularError;

    fn try_from(value: &str) -> Result<Self> {
        match value {
            "done" => Ok(Self::Done),
            "undone" => Ok(Self::Undone),
            _ => Err(SyncularError::storage(anyhow::anyhow!(
                "invalid sync_command_history.state: {value}"
            ))),
        }
    }
}

impl fmt::Display for CommandHistoryState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub table: String,
    pub row_id: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryRecord {
    pub id: String,
    pub mutation_scope: String,
    pub state: CommandHistoryState,
    pub entries: Vec<CommandHistoryEntry>,
    pub client_commit_id: String,
    pub undo_client_commit_id: Option<String>,
    pub redo_client_commit_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryReceipt {
    pub command_id: String,
    pub commit: MutationReceipt,
}
