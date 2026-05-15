use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

/// Temporary SQLite database path that removes the database and sidecar files
/// when dropped.
#[derive(Debug)]
pub struct TempDbPath {
    path: PathBuf,
}

impl TempDbPath {
    pub fn new(prefix: impl AsRef<str>) -> Self {
        let sanitized = sanitize_prefix(prefix.as_ref());
        let path = std::env::temp_dir().join(format!(
            "{sanitized}-{}-{}.sqlite",
            std::process::id(),
            Uuid::new_v4()
        ));
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn to_string_lossy(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    pub fn remove_now(&self) {
        remove_sqlite_path(&self.path);
    }
}

impl AsRef<Path> for TempDbPath {
    fn as_ref(&self) -> &Path {
        self.path()
    }
}

impl Drop for TempDbPath {
    fn drop(&mut self) {
        remove_sqlite_path(&self.path);
    }
}

pub fn temp_db_path(prefix: impl AsRef<str>) -> TempDbPath {
    TempDbPath::new(prefix)
}

pub fn unique_temp_db_path(prefix: impl AsRef<str>) -> String {
    TempDbPath::new(prefix).to_string_lossy()
}

pub fn unique_temp_file_path(prefix: impl AsRef<str>) -> String {
    let sanitized = sanitize_prefix(prefix.as_ref());
    std::env::temp_dir()
        .join(format!(
            "{sanitized}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ))
        .to_string_lossy()
        .into_owned()
}

fn remove_sqlite_path(path: &Path) {
    let _ = fs::remove_file(path);
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix));
        let _ = fs::remove_file(sidecar);
    }
}

fn sanitize_prefix(prefix: &str) -> String {
    prefix
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}
