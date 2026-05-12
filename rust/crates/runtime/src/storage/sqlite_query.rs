use crate::error::{Result, SyncularError};
use crate::generated::table_metadata;
use libsqlite3_sys as sqlite;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::collections::BTreeSet;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::slice;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadonlySqlQueryRequest {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    #[serde(default)]
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadonlySqlQueryResult {
    pub rows: Vec<Value>,
}

struct SqliteDb {
    raw: *mut sqlite::sqlite3,
}

struct SqliteStatement {
    raw: *mut sqlite::sqlite3_stmt,
}

struct AuthorizerContext {
    allowed_tables: BTreeSet<String>,
    denied: Option<String>,
}

impl Drop for SqliteDb {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                sqlite::sqlite3_close(self.raw);
            }
        }
    }
}

impl Drop for SqliteStatement {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                sqlite::sqlite3_finalize(self.raw);
            }
        }
    }
}

pub fn execute_readonly_query_json(db_path: &str, request_json: &str) -> Result<String> {
    let request: ReadonlySqlQueryRequest = serde_json::from_str(request_json)?;
    let result = execute_readonly_query(db_path, request)?;
    Ok(serde_json::to_string(&result)?)
}

pub fn execute_readonly_query(
    db_path: &str,
    request: ReadonlySqlQueryRequest,
) -> Result<ReadonlySqlQueryResult> {
    if request.sql.trim().is_empty() {
        return Err(SyncularError::config("query SQL must not be empty"));
    }

    let allowed_tables = validate_tables(&request.tables)?;
    let db = open_db(db_path)?;
    let mut authorizer = AuthorizerContext {
        allowed_tables,
        denied: None,
    };
    install_authorizer(&db, &mut authorizer)?;

    let stmt = match prepare_single_statement(&db, &request.sql) {
        Ok(stmt) => stmt,
        Err(error) => {
            if let Some(message) = authorizer.denied {
                return Err(SyncularError::config(message));
            }
            return Err(error);
        }
    };
    if unsafe { sqlite::sqlite3_stmt_readonly(stmt.raw) } == 0 {
        return Err(SyncularError::config(
            "queryJson only accepts read-only SQL; use applyLocalOperationJson for Syncular writes",
        ));
    }

    bind_params(&db, &stmt, &request.params)?;
    let rows = match read_rows(&db, &stmt) {
        Ok(rows) => rows,
        Err(error) => {
            if let Some(message) = authorizer.denied {
                return Err(SyncularError::config(message));
            }
            return Err(error);
        }
    };
    if let Some(message) = authorizer.denied {
        return Err(SyncularError::config(message));
    }

    Ok(ReadonlySqlQueryResult { rows })
}

fn validate_tables(tables: &[String]) -> Result<BTreeSet<String>> {
    let mut allowed = BTreeSet::new();
    for table in tables {
        let table = table.trim();
        if table.is_empty() {
            return Err(SyncularError::config("query table dependency is empty"));
        }
        if table_metadata(table).is_none() {
            return Err(SyncularError::config(format!(
                "queryJson can only read generated app tables; unknown table: {table}"
            )));
        }
        allowed.insert(table.to_string());
    }
    Ok(allowed)
}

fn open_db(db_path: &str) -> Result<SqliteDb> {
    let path = CString::new(db_path)
        .map_err(|_| SyncularError::config("database path contains interior NUL byte"))?;
    let mut raw = ptr::null_mut();
    let rc = unsafe {
        sqlite::sqlite3_open_v2(
            path.as_ptr(),
            &mut raw,
            sqlite::SQLITE_OPEN_READONLY,
            ptr::null(),
        )
    };
    if rc != sqlite::SQLITE_OK {
        let message = sqlite_message(raw, "open read-only query connection");
        if !raw.is_null() {
            unsafe {
                sqlite::sqlite3_close(raw);
            }
        }
        return Err(message);
    }

    Ok(SqliteDb { raw })
}

fn install_authorizer(db: &SqliteDb, context: &mut AuthorizerContext) -> Result<()> {
    let rc = unsafe {
        sqlite::sqlite3_set_authorizer(
            db.raw,
            Some(readonly_authorizer),
            context as *mut AuthorizerContext as *mut c_void,
        )
    };
    if rc != sqlite::SQLITE_OK {
        return Err(sqlite_message(db.raw, "install query authorizer"));
    }
    Ok(())
}

fn prepare_single_statement(db: &SqliteDb, sql: &str) -> Result<SqliteStatement> {
    let sql = CString::new(sql)
        .map_err(|_| SyncularError::config("query SQL contains interior NUL byte"))?;
    let mut raw = ptr::null_mut();
    let mut tail = ptr::null();
    let rc = unsafe { sqlite::sqlite3_prepare_v2(db.raw, sql.as_ptr(), -1, &mut raw, &mut tail) };
    if rc != sqlite::SQLITE_OK {
        return Err(sqlite_message(db.raw, "prepare read-only query"));
    }
    if raw.is_null() {
        return Err(SyncularError::config(
            "query SQL did not prepare a statement",
        ));
    }
    if !tail.is_null() {
        let tail = unsafe { CStr::from_ptr(tail) }
            .to_string_lossy()
            .trim()
            .to_string();
        if !tail.is_empty() {
            unsafe {
                sqlite::sqlite3_finalize(raw);
            }
            return Err(SyncularError::config(
                "queryJson accepts exactly one SQL statement",
            ));
        }
    }

    Ok(SqliteStatement { raw })
}

fn bind_params(db: &SqliteDb, stmt: &SqliteStatement, params: &[Value]) -> Result<()> {
    let expected = unsafe { sqlite::sqlite3_bind_parameter_count(stmt.raw) };
    if expected as usize != params.len() {
        return Err(SyncularError::config(format!(
            "query parameter count mismatch: SQL expects {expected}, request supplied {}",
            params.len()
        )));
    }

    for (index, value) in params.iter().enumerate() {
        let parameter = (index + 1) as c_int;
        let rc = match value {
            Value::Null => unsafe { sqlite::sqlite3_bind_null(stmt.raw, parameter) },
            Value::Bool(value) => unsafe {
                sqlite::sqlite3_bind_int64(stmt.raw, parameter, i64::from(*value))
            },
            Value::Number(number) => bind_number(stmt.raw, parameter, number),
            Value::String(value) => bind_text(stmt.raw, parameter, value)?,
            Value::Array(_) | Value::Object(_) => {
                return Err(SyncularError::config(
                    "query params must be scalar JSON values",
                ));
            }
        };
        if rc != sqlite::SQLITE_OK {
            return Err(sqlite_message(db.raw, "bind query parameter"));
        }
    }

    Ok(())
}

fn bind_number(stmt: *mut sqlite::sqlite3_stmt, parameter: c_int, number: &Number) -> c_int {
    if let Some(value) = number.as_i64() {
        unsafe { sqlite::sqlite3_bind_int64(stmt, parameter, value) }
    } else if let Some(value) = number.as_u64() {
        if value <= i64::MAX as u64 {
            unsafe { sqlite::sqlite3_bind_int64(stmt, parameter, value as i64) }
        } else {
            sqlite::SQLITE_TOOBIG
        }
    } else if let Some(value) = number.as_f64() {
        unsafe { sqlite::sqlite3_bind_double(stmt, parameter, value) }
    } else {
        sqlite::SQLITE_MISMATCH
    }
}

fn bind_text(stmt: *mut sqlite::sqlite3_stmt, parameter: c_int, value: &str) -> Result<c_int> {
    let value = CString::new(value)
        .map_err(|_| SyncularError::config("query string param contains interior NUL byte"))?;
    Ok(unsafe {
        sqlite::sqlite3_bind_text(
            stmt,
            parameter,
            value.as_ptr(),
            value.as_bytes().len() as c_int,
            sqlite::SQLITE_TRANSIENT(),
        )
    })
}

fn read_rows(db: &SqliteDb, stmt: &SqliteStatement) -> Result<Vec<Value>> {
    let column_count = unsafe { sqlite::sqlite3_column_count(stmt.raw) };
    let mut rows = Vec::new();

    loop {
        match unsafe { sqlite::sqlite3_step(stmt.raw) } {
            sqlite::SQLITE_ROW => rows.push(read_row(stmt.raw, column_count)?),
            sqlite::SQLITE_DONE => break,
            _ => return Err(sqlite_message(db.raw, "step read-only query")),
        }
    }

    Ok(rows)
}

fn read_row(stmt: *mut sqlite::sqlite3_stmt, column_count: c_int) -> Result<Value> {
    let mut row = Map::new();
    for column in 0..column_count {
        let name = column_name(stmt, column)?;
        let value = column_value(stmt, column)?;
        row.insert(name, value);
    }
    Ok(Value::Object(row))
}

fn column_name(stmt: *mut sqlite::sqlite3_stmt, column: c_int) -> Result<String> {
    let raw = unsafe { sqlite::sqlite3_column_name(stmt, column) };
    if raw.is_null() {
        return Err(SyncularError::storage(anyhow::anyhow!(
            "SQLite returned a null column name"
        )));
    }
    Ok(unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned())
}

fn column_value(stmt: *mut sqlite::sqlite3_stmt, column: c_int) -> Result<Value> {
    match unsafe { sqlite::sqlite3_column_type(stmt, column) } {
        sqlite::SQLITE_NULL => Ok(Value::Null),
        sqlite::SQLITE_INTEGER => Ok(Value::Number(Number::from(unsafe {
            sqlite::sqlite3_column_int64(stmt, column)
        }))),
        sqlite::SQLITE_FLOAT => {
            let value = unsafe { sqlite::sqlite3_column_double(stmt, column) };
            Ok(Number::from_f64(value).map_or(Value::Null, Value::Number))
        }
        sqlite::SQLITE_TEXT => {
            let raw = unsafe { sqlite::sqlite3_column_text(stmt, column) };
            let len = unsafe { sqlite::sqlite3_column_bytes(stmt, column) };
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = unsafe { slice::from_raw_parts(raw, len as usize) };
            let value = std::str::from_utf8(bytes)
                .map_err(|error| SyncularError::storage(anyhow::anyhow!(error)))?;
            Ok(Value::String(value.to_string()))
        }
        sqlite::SQLITE_BLOB => {
            let raw = unsafe { sqlite::sqlite3_column_blob(stmt, column) };
            let len = unsafe { sqlite::sqlite3_column_bytes(stmt, column) };
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = unsafe { slice::from_raw_parts(raw.cast::<u8>(), len as usize) };
            Ok(json_blob(bytes))
        }
        _ => Err(SyncularError::storage(anyhow::anyhow!(
            "unknown SQLite column type"
        ))),
    }
}

fn json_blob(bytes: &[u8]) -> Value {
    let mut value = Map::new();
    value.insert(
        "$syncularType".to_string(),
        Value::String("blob".to_string()),
    );
    value.insert("hex".to_string(), Value::String(hex::encode(bytes)));
    Value::Object(value)
}

fn sqlite_message(db: *mut sqlite::sqlite3, action: &str) -> SyncularError {
    if db.is_null() {
        return SyncularError::storage(anyhow::anyhow!("{action} failed"));
    }
    let message = unsafe { CStr::from_ptr(sqlite::sqlite3_errmsg(db)) }
        .to_string_lossy()
        .into_owned();
    SyncularError::storage(anyhow::anyhow!("{action} failed: {message}"))
}

unsafe extern "C" fn readonly_authorizer(
    user_data: *mut c_void,
    action: c_int,
    arg1: *const c_char,
    _arg2: *const c_char,
    _database: *const c_char,
    _trigger: *const c_char,
) -> c_int {
    let context = &mut *(user_data as *mut AuthorizerContext);
    match action {
        sqlite::SQLITE_SELECT | sqlite::SQLITE_FUNCTION => sqlite::SQLITE_OK,
        sqlite::SQLITE_READ => {
            let table = cstr_arg(arg1);
            if table
                .as_deref()
                .is_some_and(|table| context.allowed_tables.contains(table))
            {
                sqlite::SQLITE_OK
            } else {
                context.denied = Some(match table {
                    Some(table) => format!(
                        "queryJson can only read declared generated app tables; denied table: {table}"
                    ),
                    None => "queryJson denied an unreadable table reference".to_string(),
                });
                sqlite::SQLITE_DENY
            }
        }
        _ => {
            context.denied = Some(format!(
                "queryJson only allows read-only SELECT statements; denied SQLite action {action}"
            ));
            sqlite::SQLITE_DENY
        }
    }
}

fn cstr_arg(raw: *const c_char) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(raw) }
            .to_string_lossy()
            .into_owned(),
    )
}
