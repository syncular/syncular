use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use std::fmt;

pub type Result<T> = std::result::Result<T, SyncularError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorKind {
    Busy,
    Config,
    Storage,
    Transport,
    Protocol,
    Schema,
    Codegen,
    Internal,
}

#[derive(Debug)]
pub struct SyncularError {
    kind: ErrorKind,
    source: anyhow::Error,
}

impl SyncularError {
    pub fn new(kind: ErrorKind, source: impl Into<anyhow::Error>) -> Self {
        Self {
            kind,
            source: source.into(),
        }
    }

    pub fn message(kind: ErrorKind, message: impl fmt::Display) -> Self {
        Self::new(kind, anyhow!(message.to_string()))
    }

    pub fn config(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Config, message)
    }

    pub fn busy(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Busy, message)
    }

    pub fn storage(source: impl Into<anyhow::Error>) -> Self {
        Self::new(ErrorKind::Storage, source)
    }

    pub fn transport(source: impl Into<anyhow::Error>) -> Self {
        Self::new(ErrorKind::Transport, source)
    }

    pub fn protocol(source: impl Into<anyhow::Error>) -> Self {
        Self::new(ErrorKind::Protocol, source)
    }

    pub fn protocol_message(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Protocol, message)
    }

    pub fn schema(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Schema, message)
    }

    pub fn codegen(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Codegen, message)
    }

    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub fn message_text(&self) -> String {
        self.source.to_string()
    }

    pub fn debug_text(&self) -> String {
        self.to_string()
    }

    pub fn context(self, context: impl fmt::Display) -> Self {
        Self {
            kind: self.kind,
            source: self.source.context(context.to_string()),
        }
    }
}

impl fmt::Display for SyncularError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.source)
    }
}

impl std::error::Error for SyncularError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

impl From<anyhow::Error> for SyncularError {
    fn from(source: anyhow::Error) -> Self {
        Self::new(ErrorKind::Internal, source)
    }
}

#[cfg(feature = "native")]
impl From<diesel::ConnectionError> for SyncularError {
    fn from(source: diesel::ConnectionError) -> Self {
        Self::storage(source)
    }
}

#[cfg(feature = "native")]
impl From<diesel::result::Error> for SyncularError {
    fn from(source: diesel::result::Error) -> Self {
        Self::storage(source)
    }
}

#[cfg(feature = "native")]
impl From<rusqlite::Error> for SyncularError {
    fn from(source: rusqlite::Error) -> Self {
        Self::storage(source)
    }
}

#[cfg(feature = "native")]
impl From<reqwest::Error> for SyncularError {
    fn from(source: reqwest::Error) -> Self {
        Self::transport(source)
    }
}

#[cfg(feature = "native")]
impl From<reqwest::header::InvalidHeaderValue> for SyncularError {
    fn from(source: reqwest::header::InvalidHeaderValue) -> Self {
        Self::transport(source)
    }
}

#[cfg(feature = "native")]
impl From<tungstenite::Error> for SyncularError {
    fn from(source: tungstenite::Error) -> Self {
        Self::transport(source)
    }
}

impl From<serde_json::Error> for SyncularError {
    fn from(source: serde_json::Error) -> Self {
        Self::protocol(source)
    }
}

impl From<std::io::Error> for SyncularError {
    fn from(source: std::io::Error) -> Self {
        Self::new(ErrorKind::Internal, source)
    }
}
