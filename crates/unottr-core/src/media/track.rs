use serde::{Deserialize, Serialize};

use super::Probe;
use crate::error::{Error, Result};

/// What the user (or a watch folder) asked for. `audio_index`-based throughout, because
/// "track 2" is the concept people have, not a global stream index.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TrackRule {
    #[default]
    Auto,
    Stream {
        stream: u32,
    },
    MicDesktop {
        mic: u32,
        desktop: u32,
    },
}

/// What the pipeline will actually do.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Selection {
    /// One mixed track; diarization has to separate everyone by voice.
    Blind { stream: u32 },
    /// Mic is a known speaker, so only the remote participants need diarizing.
    MicDesktop { mic: u32, desktop: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackChoice {
    pub selection: Selection,
    /// Logged at INFO. When a user reports bad speaker labels this is the first thing to read.
    pub reason: String,
}

pub fn select(probe: &Probe, rule: &TrackRule) -> Result<TrackChoice> {
    if probe.audio.is_empty() {
        return Err(Error::NoAudio {
            path: Default::default(),
        });
    }

    match rule {
        TrackRule::Stream { stream } => {
            require(probe, *stream)?;
            Ok(TrackChoice {
                selection: Selection::Blind { stream: *stream },
                reason: format!("track {stream} forced by configuration"),
            })
        }
        TrackRule::MicDesktop { mic, desktop } => {
            require(probe, *mic)?;
            require(probe, *desktop)?;
            Ok(TrackChoice {
                selection: Selection::MicDesktop {
                    mic: *mic,
                    desktop: *desktop,
                },
                reason: format!("mic={mic} desktop={desktop} forced by configuration"),
            })
        }
        TrackRule::Auto => Ok(auto(probe)),
    }
}

fn auto(probe: &Probe) -> TrackChoice {
    let first = probe.audio[0].audio_index;

    // 1. single track: every OBS simple-mode recording lands here
    if probe.audio.len() == 1 {
        return TrackChoice {
            selection: Selection::Blind { stream: first },
            reason: "single audio track".into(),
        };
    }

    // 2. named tracks. mkv keeps titles; mp4 usually drops them, so this rarely fires
    let mic = probe
        .audio
        .iter()
        .find(|s| title_has(s.title.as_deref(), &["mic"]));
    let desktop = probe
        .audio
        .iter()
        .find(|s| title_has(s.title.as_deref(), &["desktop", "system", "speaker"]));
    if let (Some(mic), Some(desktop)) = (mic, desktop)
        && mic.audio_index != desktop.audio_index
    {
        return TrackChoice {
            selection: Selection::MicDesktop {
                mic: mic.audio_index,
                desktop: desktop.audio_index,
            },
            reason: format!(
                "track titles: mic={:?} desktop={:?}",
                mic.title.as_deref().unwrap_or(""),
                desktop.title.as_deref().unwrap_or("")
            ),
        };
    }

    // 3. exactly one mono track among stereo ones: the mono one is almost certainly a mic
    let monos: Vec<_> = probe.audio.iter().filter(|s| s.channels == 1).collect();
    if monos.len() == 1 {
        let mic = monos[0];
        if let Some(desktop) = probe.audio.iter().find(|s| s.channels > 1) {
            return TrackChoice {
                selection: Selection::MicDesktop {
                    mic: mic.audio_index,
                    desktop: desktop.audio_index,
                },
                reason: format!(
                    "one mono track ({}) among {} multi-channel tracks",
                    mic.audio_index,
                    probe.audio.len() - 1
                ),
            };
        }
    }

    // 4. give up and take the first track
    TrackChoice {
        selection: Selection::Blind { stream: first },
        reason: format!(
            "{} tracks, none identifiable; using the first",
            probe.audio.len()
        ),
    }
}

fn title_has(title: Option<&str>, needles: &[&str]) -> bool {
    let Some(title) = title else { return false };
    let title = title.to_lowercase();
    needles.iter().any(|n| title.contains(n))
}

fn require(probe: &Probe, audio_index: u32) -> Result<()> {
    if probe.stream(audio_index).is_some() {
        Ok(())
    } else {
        Err(Error::Probe {
            path: Default::default(),
            reason: format!(
                "audio track {audio_index} does not exist; file has {}",
                probe.audio.len()
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::AudioStream;

    fn stream(audio_index: u32, channels: u16, title: Option<&str>) -> AudioStream {
        AudioStream {
            index: audio_index + 1,
            audio_index,
            codec: "aac".into(),
            channels,
            sample_rate: 48_000,
            title: title.map(str::to_string),
            language: None,
        }
    }

    fn probe(audio: Vec<AudioStream>) -> Probe {
        Probe {
            container: "matroska".into(),
            duration_ms: Some(1000),
            has_video: true,
            audio,
        }
    }

    #[test]
    fn single_track_is_blind() {
        let p = probe(vec![stream(0, 2, None)]);
        let choice = select(&p, &TrackRule::Auto).unwrap();
        assert_eq!(choice.selection, Selection::Blind { stream: 0 });
    }

    #[test]
    fn titled_tracks_split_mic_and_desktop() {
        let p = probe(vec![
            stream(0, 2, Some("Mix")),
            stream(1, 2, Some("Microphone")),
            stream(2, 2, Some("Desktop Audio")),
        ]);
        let choice = select(&p, &TrackRule::Auto).unwrap();
        assert_eq!(
            choice.selection,
            Selection::MicDesktop { mic: 1, desktop: 2 }
        );
    }

    #[test]
    fn lone_mono_track_is_the_mic() {
        let p = probe(vec![stream(0, 2, None), stream(1, 1, None)]);
        let choice = select(&p, &TrackRule::Auto).unwrap();
        assert_eq!(
            choice.selection,
            Selection::MicDesktop { mic: 1, desktop: 0 }
        );
    }

    #[test]
    fn two_mono_tracks_are_not_guessable() {
        let p = probe(vec![stream(0, 1, None), stream(1, 1, None)]);
        let choice = select(&p, &TrackRule::Auto).unwrap();
        assert_eq!(choice.selection, Selection::Blind { stream: 0 });
    }

    #[test]
    fn unidentifiable_multitrack_falls_back_to_first() {
        let p = probe(vec![
            stream(0, 2, Some("Track 1")),
            stream(1, 2, Some("Track 2")),
        ]);
        let choice = select(&p, &TrackRule::Auto).unwrap();
        assert_eq!(choice.selection, Selection::Blind { stream: 0 });
    }

    #[test]
    fn override_beats_the_heuristic() {
        let p = probe(vec![stream(0, 2, None), stream(1, 1, None)]);
        let choice = select(&p, &TrackRule::Stream { stream: 0 }).unwrap();
        assert_eq!(choice.selection, Selection::Blind { stream: 0 });
    }

    #[test]
    fn override_to_a_missing_track_is_an_error() {
        let p = probe(vec![stream(0, 2, None)]);
        assert!(select(&p, &TrackRule::Stream { stream: 7 }).is_err());
    }

    #[test]
    fn no_audio_is_an_error() {
        assert!(select(&probe(vec![]), &TrackRule::Auto).is_err());
    }
}
