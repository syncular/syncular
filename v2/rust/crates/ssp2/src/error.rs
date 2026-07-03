//! Decode errors carrying the SPEC-named error codes (SPEC.md §1.7, §10).

use std::fmt;

/// The closed set of error codes a conformant decoder may produce
/// (SPEC.md §1.7: `sync.invalid_request` unless a code is named).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// `sync.invalid_request` — envelope/framing/grammar/primitive violations.
    InvalidRequest,
    /// `sync.empty_commit` — `PUSH_COMMIT` with zero operations (§6.1).
    EmptyCommit,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidRequest => "sync.invalid_request",
            ErrorCode::EmptyCommit => "sync.empty_commit",
        }
    }
}

/// A decode failure: the SPEC-named code plus a human-oriented detail.
#[derive(Debug, Clone)]
pub struct DecodeError {
    pub code: ErrorCode,
    pub detail: String,
}

impl DecodeError {
    pub fn invalid(detail: impl Into<String>) -> Self {
        DecodeError {
            code: ErrorCode::InvalidRequest,
            detail: detail.into(),
        }
    }

    pub fn empty_commit(detail: impl Into<String>) -> Self {
        DecodeError {
            code: ErrorCode::EmptyCommit,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for DecodeError {}

pub type Result<T> = std::result::Result<T, DecodeError>;
