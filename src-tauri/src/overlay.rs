use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager};

pub const FILE_NAME: &str = "mac-overlay.json";

#[derive(Default, Serialize, Deserialize)]
struct OverlayData {
    #[serde(default)]
    float_over_fullscreen: bool,
}

/// Rust-owned overlay preference. The frontend never sends this flag, so the
/// persisted file is the only source of truth for the native menu checkmark.
pub struct OverlayState {
    path: PathBuf,
    enabled: AtomicBool,
}

impl OverlayState {
    pub fn new(path: PathBuf) -> Self {
        let enabled = load(&path);
        Self {
            path,
            enabled: AtomicBool::new(enabled),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        save(&self.path, enabled)?;
        self.enabled.store(enabled, Ordering::Release);
        Ok(())
    }
}

pub fn enabled(app: &AppHandle) -> bool {
    app.try_state::<OverlayState>()
        .is_some_and(|state| state.enabled())
}

/// A missing or unreadable file simply means "feature off".
pub fn load(path: &Path) -> bool {
    let Ok(contents) = fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<OverlayData>(&contents).is_ok_and(|data| data.float_over_fullscreen)
}

pub fn save(path: &Path, enabled: bool) -> Result<(), String> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("overlay_directory_failed: {error}"))?;
    }
    let encoded = serde_json::to_vec(&OverlayData {
        float_over_fullscreen: enabled,
    })
    .map_err(|error| format!("overlay_serialize_failed: {error}"))?;
    fs::write(path, encoded).map_err(|error| format!("overlay_write_failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "wuwatappo-overlay-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> PathBuf {
            self.0.join(FILE_NAME)
        }
        fn state(&self) -> OverlayState {
            OverlayState::new(self.file())
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_file_reads_as_disabled() {
        let directory = TestDirectory::new();
        assert!(!load(&directory.file()));
        assert!(!directory.state().enabled());
    }

    #[test]
    fn saved_value_survives_reopen() {
        let directory = TestDirectory::new();
        directory.state().set_enabled(true).unwrap();
        assert!(load(&directory.file()));
        assert!(directory.state().enabled());
        directory.state().set_enabled(false).unwrap();
        assert!(!load(&directory.file()));
        assert!(!directory.state().enabled());
    }

    #[test]
    fn malformed_file_reads_as_disabled() {
        let directory = TestDirectory::new();
        fs::write(directory.file(), b"{broken-json").unwrap();
        assert!(!directory.state().enabled());
        fs::write(directory.file(), br#"{"float_over_fullscreen":true}"#).unwrap();
        assert!(directory.state().enabled());
    }
}
