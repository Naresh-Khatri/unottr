// pub: events.rs helpers aren't called yet (no worker to call them), so they need to be
// reachable as public API or dead_code would flag them.
pub mod ipc;
mod scope;

use tauri::Manager;
use tracing::{info, warn};
use unottr_core::{Database, Paths};

/// Shared handles for the IPC commands that phase 05 adds.
pub struct AppState {
    pub paths: Paths,
    pub db: Database,
}

pub fn run() {
    let paths = Paths::resolve().expect("resolve application directories");
    paths.ensure().expect("create application directories");
    let _log_guard = unottr_core::logging::init(&paths).expect("init logging");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ipc::commands::list_recordings,
            ipc::commands::get_recording,
            ipc::commands::search,
            ipc::commands::rename_speaker,
            ipc::commands::retry_job,
            ipc::commands::add_watch_folder,
            ipc::commands::remove_watch_folder,
            ipc::commands::list_watch_folders,
            ipc::commands::start_backfill,
        ])
        .setup(move |app| {
            let db = Database::open(paths.db_file())?;
            info!(db = %db.path().display(), "storage ready");

            // recordings/watch folders may already exist (prior runs, seeded db); the static
            // scope in tauri.conf.json is empty, so convertFileSrc needs this to work at all
            if let Ok(conn) = db.connect()
                && let Err(e) = scope::seed_from_db(app.handle(), &conn)
            {
                warn!(error = %e, "failed to seed asset protocol scope");
            }

            app.manage(AppState {
                paths: paths.clone(),
                db,
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run tauri application");
}
