//! Tray icon, menu, and close-to-tray window lifecycle (06-settings-and-shell.md).
//!
//! `build` can fail — some Linux sessions have no notification area at all. When it does,
//! `run()`'s setup leaves `AppState.tray` `None` and never intercepts `CloseRequested`, so
//! closing the window falls through to tauri's normal single-window exit path (which already
//! runs the graceful `IngestService::shutdown` via the `RunEvent::Exit` handler in `run()`).
//! That's the "quit must be graceful" half of the degradation; the "one-time explanation"
//! half is a permanent banner in Settings driven by `tray_available` in `get_settings`,
//! rather than a toast timed to the close click — simpler to get right without a running app
//! to click through, and arguably more honest than a hint that can be missed.

use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

const SHOW_ID: &str = "show";
const STATUS_ID: &str = "status";
const QUIT_ID: &str = "quit";

/// "Idle" when nothing is running, else "Transcribing N of M". `active` is 0 or 1 today
/// (worker concurrency is 1, see ingest/worker.rs) but the format doesn't assume that.
pub fn status_line(active: usize, total: usize) -> String {
    if active == 0 {
        "Idle".to_string()
    } else {
        format!("Transcribing {active} of {total}")
    }
}

pub struct Tray {
    pub icon: TrayIcon,
    status_item: MenuItem<tauri::Wry>,
}

impl Tray {
    /// Updates the status menu line in place. Cheap to call on every job event — the tray
    /// backend no-ops a `set_text` with unchanged text, and this crate has no busier caller.
    pub fn set_status(&self, active: usize, total: usize) {
        let line = status_line(active, total);
        if let Err(e) = self.status_item.set_text(&line) {
            warn!(error = %e, "failed to update tray status line");
        }
    }

    /// Sets the tray tooltip to a one-time "still running" hint on the first hide-to-tray,
    /// then leaves it alone. `already_explained` is the persisted flag from
    /// `unottr_core::db::settings::close_to_tray_explained` — the caller marks it before
    /// this is called again.
    pub fn hint_first_hide(&self, already_explained: bool) {
        if already_explained {
            return;
        }
        if let Err(e) = self.icon.set_tooltip(Some("unottr — still running here")) {
            warn!(error = %e, "failed to set tray hint tooltip");
        }
    }
}

/// Builds the tray icon and menu (Show / status line / Quit). `Err` means this session has
/// no tray to build onto.
pub fn build(app: &AppHandle) -> tauri::Result<Tray> {
    let show = MenuItemBuilder::with_id(SHOW_ID, "Show unottr").build(app)?;
    let status = MenuItemBuilder::with_id(STATUS_ID, status_line(0, 0))
        .enabled(false)
        .build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT_ID, "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&status)
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = tauri::tray::TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("unottr")
        .on_menu_event(|app, event| match event.id.as_ref() {
            SHOW_ID => show_main_window(app),
            QUIT_ID => {
                info!("quit requested from tray menu");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let icon = builder.build(app)?;
    Ok(Tray { icon, status_item: status })
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_when_nothing_active() {
        assert_eq!(status_line(0, 0), "Idle");
        assert_eq!(status_line(0, 3), "Idle");
    }

    #[test]
    fn transcribing_reports_active_of_total() {
        assert_eq!(status_line(1, 4), "Transcribing 1 of 4");
    }
}
