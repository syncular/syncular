//! Crash recovery for the browser worker's OPFS VFS.
//!
//! The `opfs-sahpool` VFS in `sqlite-wasm-vfs` 0.2.0 reports a reserved lock
//! unconditionally (`xCheckReservedLock` writes 1). SQLite reads that as
//! "another process owns the hot journal" and skips rollback after a worker is
//! killed mid-commit; the next writer then commits over a half-rolled-back
//! image. The sqlite-wasm JS binding ships the same workaround, and the
//! TypeScript client applies it in `packages/web-client/src/wasm-database.ts`.
//!
//! `sqlite-wasm-vfs` exposes no callback for the file methods, so this module
//! wraps the installed VFS's `xOpen`: after the original opens a file, the
//! file's method table is replaced by a copy whose `xCheckReservedLock` always
//! writes 0. The pool already excludes other owners; the report only has to
//! stop suppressing crash rollback. Everything runs before the first
//! connection opens its database file.

use std::cell::RefCell;
use std::ffi::c_int;

use rusqlite::ffi::{
    sqlite3_file, sqlite3_filename, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find,
    SQLITE_IOERR, SQLITE_OK,
};

type XOpen = unsafe extern "C" fn(
    *mut sqlite3_vfs,
    sqlite3_filename,
    *mut sqlite3_file,
    c_int,
    *mut c_int,
) -> c_int;

thread_local! {
    /// One entry per patched VFS: the original `xOpen` the wrapper delegates to.
    static ORIGINALS: RefCell<Vec<(*mut sqlite3_vfs, XOpen)>> = const { RefCell::new(Vec::new()) };
    /// One patched method table per original table. All files of one VFS share it.
    static METHODS: RefCell<Vec<(*const sqlite3_io_methods, *mut sqlite3_io_methods)>> =
        const { RefCell::new(Vec::new()) };
}

/// Make the default VFS report no foreign reserved lock, so SQLite replays a
/// hot rollback journal left by a killed worker. Idempotent; call it after the
/// host installs its OPFS VFS and before the first `Connection::open`.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub(crate) fn disable_foreign_lock_check() -> Result<(), String> {
    let vfs = unsafe { sqlite3_vfs_find(std::ptr::null()) };
    if vfs.is_null() {
        return Err("client.storage_unavailable: no SQLite VFS is registered".to_owned());
    }
    patch_vfs(vfs)
}

fn patch_vfs(vfs: *mut sqlite3_vfs) -> Result<(), String> {
    if ORIGINALS.with(|originals| {
        originals
            .borrow()
            .iter()
            .any(|(patched, _)| *patched == vfs)
    }) {
        return Ok(());
    }
    let original = unsafe { (*vfs).xOpen }
        .ok_or_else(|| "client.storage_unavailable: the SQLite VFS has no xOpen".to_owned())?;
    ORIGINALS.with(|originals| originals.borrow_mut().push((vfs, original)));
    // SAFETY: the VFS was registered by `sqlite-wasm-vfs` as a leaked
    // `Box<sqlite3_vfs>`, so its fields are writable for the process lifetime.
    unsafe { (*vfs).xOpen = Some(crash_recovery_open) };
    Ok(())
}

unsafe extern "C" fn crash_recovery_open(
    p_vfs: *mut sqlite3_vfs,
    name: sqlite3_filename,
    file: *mut sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    let Some(original) = ORIGINALS.with(|originals| {
        originals
            .borrow()
            .iter()
            .find(|(patched, _)| *patched == p_vfs)
            .map(|(_, original)| *original)
    }) else {
        return SQLITE_IOERR;
    };
    let code = original(p_vfs, name, file, flags, out_flags);
    if code == SQLITE_OK && !file.is_null() {
        let methods = (*file).pMethods;
        if !methods.is_null() {
            // SAFETY: `methods` belongs to the VFS that just opened the file;
            // the patched table lives for the process lifetime.
            unsafe { (*file).pMethods = patched_methods(methods) };
        }
    }
    code
}

unsafe fn patched_methods(original: *const sqlite3_io_methods) -> *const sqlite3_io_methods {
    METHODS.with(|methods| {
        let mut methods = methods.borrow_mut();
        if let Some((_, patched)) = methods.iter().find(|(source, _)| *source == original) {
            return *patched;
        }
        // SAFETY: `original` is a live SQLite method table.
        let mut patched = unsafe { *original };
        patched.xCheckReservedLock = Some(no_foreign_lock);
        let patched = Box::into_raw(Box::new(patched));
        methods.push((original, patched));
        patched
    })
}

unsafe extern "C" fn no_foreign_lock(_file: *mut sqlite3_file, reserved: *mut c_int) -> c_int {
    if !reserved.is_null() {
        // SAFETY: SQLite passes a valid out-parameter for this callback.
        unsafe { *reserved = 0 };
    }
    SQLITE_OK
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe extern "C" fn reserved_one(_file: *mut sqlite3_file, reserved: *mut c_int) -> c_int {
        // SAFETY: SQLite always passes a valid out-parameter.
        unsafe { *reserved = 1 };
        SQLITE_OK
    }

    static FAKE_METHODS: sqlite3_io_methods = sqlite3_io_methods {
        iVersion: 1,
        xClose: None,
        xRead: None,
        xWrite: None,
        xTruncate: None,
        xSync: None,
        xFileSize: None,
        xLock: None,
        xUnlock: None,
        xCheckReservedLock: Some(reserved_one),
        xFileControl: None,
        xSectorSize: None,
        xDeviceCharacteristics: None,
        xShmMap: None,
        xShmLock: None,
        xShmBarrier: None,
        xShmUnmap: None,
        xFetch: None,
        xUnfetch: None,
    };

    unsafe extern "C" fn fake_open(
        _vfs: *mut sqlite3_vfs,
        _name: sqlite3_filename,
        file: *mut sqlite3_file,
        _flags: c_int,
        _out: *mut c_int,
    ) -> c_int {
        // SAFETY: SQLite allocated a file struct for this opener.
        unsafe { (*file).pMethods = &FAKE_METHODS };
        SQLITE_OK
    }

    #[test]
    fn the_wrapper_replaces_the_reserved_lock_callback() {
        // SAFETY: a live VFS supplies valid pointers for the fields this test
        // does not exercise; only the opener is replaced.
        let mut vfs = Box::new(unsafe { *sqlite3_vfs_find(std::ptr::null()) });
        vfs.xOpen = Some(fake_open);
        patch_vfs(&mut *vfs).expect("patch the fake VFS");
        let mut file = sqlite3_file {
            pMethods: std::ptr::null(),
        };
        let mut out = 0;
        let open = vfs.xOpen.expect("patched opener");
        // SAFETY: the fake opener only writes `pMethods` and `out`.
        let code = unsafe { open(&mut *vfs, std::ptr::null(), &mut file, 0, &mut out) };
        assert_eq!(code, SQLITE_OK);
        // SAFETY: the wrapper replaced the fake table with a patched copy.
        let check = unsafe { (*file.pMethods).xCheckReservedLock }.expect("patched callback");
        let mut reserved = 1;
        // SAFETY: `check` is the live callback from the patched table.
        assert_eq!(unsafe { check(&mut file, &mut reserved) }, SQLITE_OK);
        assert_eq!(reserved, 0);
    }
}
