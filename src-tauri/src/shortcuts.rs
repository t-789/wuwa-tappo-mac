use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager};

pub const FILE_NAME: &str = "app-shortcuts.json";

/// One key combination, in the encoding the settings page already speaks:
/// `modifiers` is a bitmask (Alt 1, Ctrl 2, Shift 4, Meta 8) and `key` is the
/// DOM keyCode. `key: 0` means "unset" — the frontend renders it as empty.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shortcut {
    #[serde(default)]
    pub modifiers: u32,
    #[serde(default)]
    pub key: u32,
}

pub type Config = BTreeMap<String, Shortcut>;

#[derive(Serialize, Deserialize)]
struct ShortcutData {
    #[serde(default)]
    shortcuts: Config,
}

/// Mirrors the frontend's DEFAULT_APP_SHORTCUTS (F7 / F8 / F9) so a fresh
/// install renders a full settings page instead of empty inputs.
pub fn defaults() -> Config {
    [("gameMode", 118), ("switchScreen", 119), ("togglePet", 120)]
        .into_iter()
        .map(|(action, key)| (action.to_string(), Shortcut { modifiers: 0, key }))
        .collect()
}

/// A missing or unreadable file falls back to the defaults; a partial file only
/// overrides the actions it carries, so a stale file cannot hide a new action.
pub fn load(path: &Path) -> Config {
    let mut config = defaults();
    let Ok(contents) = fs::read(path) else {
        return config;
    };
    let Ok(data) = serde_json::from_slice::<ShortcutData>(&contents) else {
        return config;
    };
    for (action, shortcut) in data.shortcuts {
        config.insert(action, shortcut);
    }
    config
}

pub fn save(path: &Path, config: &Config) -> Result<(), String> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("shortcut_directory_failed: {error}"))?;
    }
    let encoded = serde_json::to_vec(&ShortcutData {
        shortcuts: config.clone(),
    })
    .map_err(|error| format!("shortcut_serialize_failed: {error}"))?;
    fs::write(path, encoded).map_err(|error| format!("shortcut_write_failed: {error}"))
}

/// Two actions may not own the same combination. Unset bindings (`key: 0`) are
/// not combinations, so any number of actions can stay unset at once.
fn has_duplicate(config: &Config) -> bool {
    let mut seen = BTreeMap::new();
    config
        .iter()
        .filter(|(_, shortcut)| shortcut.key != 0)
        .any(|(action, shortcut)| {
            seen.insert((shortcut.modifiers, shortcut.key), action)
                .is_some()
        })
}

pub struct ShortcutState {
    path: PathBuf,
    config: Mutex<Config>,
    capture: AtomicBool,
}

impl ShortcutState {
    pub fn new(path: PathBuf) -> Self {
        let config = load(&path);
        Self {
            path,
            config: Mutex::new(config),
            capture: AtomicBool::new(false),
        }
    }

    pub fn config(&self) -> Result<Config, String> {
        self.config
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "shortcut state lock failed".into())
    }

    /// Validation runs before anything is written, so a rejected config leaves
    /// both the file and the in-memory copy untouched.
    pub fn apply(&self, config: Config) -> Result<(), String> {
        if has_duplicate(&config) {
            return Err("duplicate".into());
        }
        let mut current = self
            .config
            .lock()
            .map_err(|_| "shortcut state lock failed".to_string())?;
        save(&self.path, &config)?;
        *current = config;
        Ok(())
    }

    /// PLACEHOLDER: capturing a combination needs a CGEventTap, which is a later
    /// piece of work. macOS records the requested state and reports success so
    /// the settings page can enter and leave capture without an error.
    pub fn set_capture(&self, active: bool) {
        self.capture.store(active, Ordering::Release);
    }

    #[cfg(test)]
    pub fn capture(&self) -> bool {
        self.capture.load(Ordering::Acquire)
    }
}

pub fn dispatch(app: &AppHandle, command: &str, args: &Value) -> Option<Result<Value, String>> {
    let Some(state) = app.try_state::<ShortcutState>() else {
        return Some(Err("Shortcut settings are unavailable".into()));
    };
    Some(match command {
        "get_app_shortcuts" => state.config().and_then(|config| {
            serde_json::to_value(config)
                .map_err(|error| format!("shortcut_serialize_failed: {error}"))
        }),
        "set_app_shortcuts" => args
            .get("config")
            .cloned()
            .ok_or_else(|| "shortcut_config_missing".to_string())
            .and_then(|value| {
                serde_json::from_value::<Config>(value)
                    .map_err(|error| format!("shortcut_config_invalid: {error}"))
            })
            .and_then(|config| state.apply(config))
            .map(|_| Value::Null),
        "set_shortcut_capture" => args
            .get("active")
            .and_then(Value::as_bool)
            .ok_or_else(|| "shortcut_capture_active_missing".to_string())
            .map(|active| {
                state.set_capture(active);
                Value::Null
            }),
        _ => return None,
    })
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
                "wuwatappo-shortcut-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> PathBuf {
            self.0.join(FILE_NAME)
        }
        fn state(&self) -> ShortcutState {
            ShortcutState::new(self.file())
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn binding(modifiers: u32, key: u32) -> Shortcut {
        Shortcut { modifiers, key }
    }

    #[test]
    fn missing_file_reads_as_renderable_defaults() {
        let directory = TestDirectory::new();
        let config = load(&directory.file());
        assert_eq!(config.get("gameMode"), Some(&binding(0, 118)));
        assert_eq!(config.get("switchScreen"), Some(&binding(0, 119)));
        assert_eq!(config.get("togglePet"), Some(&binding(0, 120)));
        assert_eq!(config.len(), 3);
    }

    #[test]
    fn saved_config_survives_reopen() {
        let directory = TestDirectory::new();
        let mut config = load(&directory.file());
        config.insert("togglePet".into(), binding(2, 84));
        directory.state().apply(config.clone()).unwrap();
        assert_eq!(load(&directory.file()), config);
        assert_eq!(directory.state().config().unwrap(), config);
    }

    #[test]
    fn duplicate_binding_is_rejected_without_touching_disk() {
        let directory = TestDirectory::new();
        let state = directory.state();
        let mut config = load(&directory.file());
        config.insert("togglePet".into(), binding(0, 118));
        assert_eq!(state.apply(config.clone()), Err("duplicate".into()));
        assert!(!directory.file().exists());
        assert_eq!(state.config().unwrap(), defaults());
    }

    #[test]
    fn unset_bindings_never_collide() {
        let directory = TestDirectory::new();
        let state = directory.state();
        let mut config = load(&directory.file());
        config.insert("gameMode".into(), binding(0, 0));
        config.insert("togglePet".into(), binding(0, 0));
        state.apply(config.clone()).unwrap();
        assert_eq!(load(&directory.file()), config);
    }

    #[test]
    fn partial_or_malformed_file_keeps_the_other_defaults() {
        let directory = TestDirectory::new();
        fs::write(
            directory.file(),
            br#"{"shortcuts":{"togglePet":{"modifiers":4,"key":32}}}"#,
        )
        .unwrap();
        let config = load(&directory.file());
        assert_eq!(config.get("togglePet"), Some(&binding(4, 32)));
        assert_eq!(config.get("gameMode"), Some(&binding(0, 118)));
        assert_eq!(config.get("switchScreen"), Some(&binding(0, 119)));
        fs::write(directory.file(), b"{broken-json").unwrap();
        assert_eq!(load(&directory.file()), defaults());
    }

    #[test]
    fn capture_state_is_recorded_and_idempotent() {
        let directory = TestDirectory::new();
        let state = directory.state();
        assert!(!state.capture());
        state.set_capture(true);
        state.set_capture(true);
        assert!(state.capture());
        state.set_capture(false);
        assert!(!state.capture());
    }
}
