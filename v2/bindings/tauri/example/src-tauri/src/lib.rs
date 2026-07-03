//! Minimal Tauri app wiring `tauri-plugin-syncular`. Proves the plugin
//! registers, constructs a native syncular instance (with the native HTTP+WS
//! transport under `native-transport`), and exposes the command + event surface
//! to the webview — where `@syncular-v2/tauri` bridges it to the React hooks.
//!
//! The db path defaults to a file under the OS app-data dir; the server base
//! URL points at a local dev server. Both are placeholders an app overrides.

use tauri::Manager;
use tauri_plugin_syncular::SyncularConfig;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Persist the syncular database under the resolved app-data dir so
            // it survives restarts (the whole point of the native instance vs.
            // eviction-prone webview OPFS).
            let db_path = app
                .path()
                .app_data_dir()
                .map(|dir| {
                    let _ = std::fs::create_dir_all(&dir);
                    dir.join("syncular.db").to_string_lossy().into_owned()
                })
                .ok();

            let config = SyncularConfig {
                base_url: Some("http://localhost:8787".to_owned()),
                db_path,
                // Real host-loop cadence with a little jitter (§8.4).
                wake_jitter_ms: 250,
                auto_sync: true,
                ..Default::default()
            };
            app.handle().plugin(tauri_plugin_syncular::init(config))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the syncular tauri example");
}
