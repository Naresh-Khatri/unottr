use tauri::Manager;
use tracing::info;
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
        .setup(move |app| {
            let db = Database::open(paths.db_file())?;
            info!(db = %db.path().display(), "storage ready");
            app.manage(AppState {
                paths: paths.clone(),
                db,
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run tauri application");
}
