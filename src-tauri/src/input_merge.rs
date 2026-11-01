//! Coalescing for high-frequency cursor movement.
//!
//! A global tap reports movement at the device rate, which is 125 Hz to 1000 Hz.
//! Forwarding every sample wakes a webview for each one even though the frontend can
//! only paint a fraction of them, so movement is throttled to a fixed rate and
//! duplicate positions are dropped. Discrete input (keys, buttons) never goes
//! through this module: it must always pass.

use std::time::{Duration, Instant};

/// Read at input-monitor start; `0` disables merging, anything else selects the rate.
pub const MOUSE_MERGE_ENV: &str = "WUWA_MOUSE_MERGE_HZ";
pub const DEFAULT_MOUSE_MERGE_HZ: u32 = 30;
/// Above the fastest display refresh a merge rate only adds jitter, so treat it as a typo.
const MAX_MOUSE_MERGE_HZ: u32 = 1000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MergePoint {
    pub x: f64,
    pub y: f64,
}

pub struct MouseMerge {
    /// `None` keeps every sample.
    window: Option<Duration>,
    last: Option<(Instant, MergePoint)>,
}

impl MouseMerge {
    pub fn from_env() -> Self {
        Self::from_spec(std::env::var(MOUSE_MERGE_ENV).ok().as_deref())
    }

    pub fn from_spec(spec: Option<&str>) -> Self {
        let window = match spec.map(str::trim).map(str::parse::<u32>) {
            None => Some(DEFAULT_MOUSE_MERGE_HZ),
            Some(Ok(0)) => None,
            Some(Ok(hz)) if hz <= MAX_MOUSE_MERGE_HZ => Some(hz),
            Some(_) => Some(DEFAULT_MOUSE_MERGE_HZ),
        };
        Self {
            window: window.map(|hz| Duration::from_nanos(1_000_000_000 / u64::from(hz))),
            last: None,
        }
    }

    /// Whether this sample reaches the frontend: the newest position wins, nothing queues.
    pub fn accept(&mut self, point: MergePoint, now: Instant) -> bool {
        if let (Some(window), Some((sent_at, sent))) = (self.window, self.last) {
            if sent == point || now.saturating_duration_since(sent_at) < window {
                return false;
            }
        }
        self.last = Some((now, point));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(x: f64, y: f64) -> MergePoint {
        MergePoint { x, y }
    }

    fn at_30hz() -> MouseMerge {
        MouseMerge::from_spec(Some("30"))
    }

    fn accepted(merge: &mut MouseMerge, position: MergePoint, millis: u64) -> bool {
        merge.accept(position, Instant::now() + Duration::from_millis(millis))
    }

    #[test]
    fn repeated_position_is_emitted_once() {
        let mut merge = at_30hz();
        assert!(accepted(&mut merge, point(10.0, 20.0), 0));
        assert!(!accepted(&mut merge, point(10.0, 20.0), 1));
        assert!(!accepted(&mut merge, point(10.0, 20.0), 500));
    }

    #[test]
    fn samples_inside_the_window_are_dropped() {
        let mut merge = at_30hz();
        assert!(accepted(&mut merge, point(0.0, 0.0), 0));
        assert!(!accepted(&mut merge, point(1.0, 1.0), 1));
        assert!(!accepted(&mut merge, point(2.0, 2.0), 32));
    }

    #[test]
    fn sample_past_the_window_passes_with_the_latest_position() {
        let mut merge = at_30hz();
        assert!(accepted(&mut merge, point(0.0, 0.0), 0));
        assert!(!accepted(&mut merge, point(1.0, 1.0), 10));
        assert!(!accepted(&mut merge, point(2.0, 2.0), 20));
        // Only the newest sample is forwarded; the dropped ones never replay.
        assert!(accepted(&mut merge, point(7.0, 8.0), 34));
        assert!(!accepted(&mut merge, point(7.0, 8.0), 67));
        assert!(!accepted(&mut merge, point(3.0, 3.0), 40));
    }

    #[test]
    fn disabled_merge_keeps_every_sample() {
        let mut merge = MouseMerge::from_spec(Some("0"));
        assert!(accepted(&mut merge, point(5.0, 5.0), 0));
        assert!(accepted(&mut merge, point(5.0, 5.0), 0));
        assert!(accepted(&mut merge, point(6.0, 6.0), 1));
    }

    #[test]
    fn invalid_rate_falls_back_to_the_default() {
        let mut merge = MouseMerge::from_spec(Some("not-a-rate"));
        assert!(accepted(&mut merge, point(0.0, 0.0), 0));
        assert!(!accepted(&mut merge, point(1.0, 1.0), 10));
        assert!(accepted(&mut merge, point(2.0, 2.0), 40));

        // A rate beyond any mouse sampling rate is a typo rather than a request for 1 µs.
        let mut absurd = MouseMerge::from_spec(Some("1000000"));
        assert!(accepted(&mut absurd, point(0.0, 0.0), 0));
        assert!(!accepted(&mut absurd, point(1.0, 1.0), 10));

        // An unset variable merges at the default rate.
        let mut unset = MouseMerge::from_spec(None);
        assert!(accepted(&mut unset, point(0.0, 0.0), 0));
        assert!(!accepted(&mut unset, point(1.0, 1.0), 10));
    }
}
