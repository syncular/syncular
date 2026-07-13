//! The desktop host: registers `tauri-plugin-syncular`, which runs the
//! NATIVE syncular core (real SQLite file + HTTP/WS transport) inside this
//! process. The webview's `@syncular/tauri` bridge is a thin RPC client of
//! it — the React tree in `src/frontend/` is byte-identical to the one the
//! browser runs against the worker core.

use tauri::Manager;
use tauri_plugin_syncular::SyncularConfig;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Persist the syncular database under the resolved app-data dir
            // so it survives restarts.
            let db_path = app
                .path()
                .app_data_dir()
                .map(|dir| {
                    let _ = std::fs::create_dir_all(&dir);
                    dir.join("syncular.db").to_string_lossy().into_owned()
                })
                .ok();

            // Points at this scaffold's own dev server (`bun run dev`,
            // port 8787). Change it to your deployed sync endpoint.
            let config = SyncularConfig {
                base_url: Some("http://localhost:8787".to_owned()),
                db_path,
                // Host-loop cadence with a little jitter (§8.4).
                wake_jitter_ms: 250,
                auto_sync: true,
                ..Default::default()
            };
            app.handle().plugin(tauri_plugin_syncular::init(config))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the tauri application");
}
