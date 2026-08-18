use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;
use tracing::{debug, warn};

use super::{AudioStream, MediaBackend, Probe, TARGET_SAMPLE_RATE};
use crate::cancel::CancelToken;
use crate::error::{Error, IoResultExt, Result};

/// Drives the system ffmpeg/ffprobe binaries.
#[derive(Debug, Clone)]
pub struct FfmpegCli {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

impl Default for FfmpegCli {
    fn default() -> Self {
        Self::discover()
    }
}

impl FfmpegCli {
    /// Env overrides exist so a bundled pair (phase 07) and tests can redirect us.
    pub fn discover() -> Self {
        Self {
            ffmpeg: env::var_os("UNOTTR_FFMPEG").map_or_else(|| "ffmpeg".into(), PathBuf::from),
            ffprobe: env::var_os("UNOTTR_FFPROBE").map_or_else(|| "ffprobe".into(), PathBuf::from),
        }
    }

    pub fn new(ffmpeg: impl Into<PathBuf>, ffprobe: impl Into<PathBuf>) -> Self {
        Self {
            ffmpeg: ffmpeg.into(),
            ffprobe: ffprobe.into(),
        }
    }

    /// Both binaries resolve and run. Surfaced in settings so the user sees the problem
    /// before a recording fails rather than after.
    pub fn check(&self) -> Result<()> {
        for bin in [&self.ffmpeg, &self.ffprobe] {
            let status = Command::new(bin)
                .arg("-version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| map_spawn(bin, e))?;
            if !status.success() {
                return Err(Error::Ffmpeg(format!("{} -version failed", bin.display())));
            }
        }
        Ok(())
    }
}

impl MediaBackend for FfmpegCli {
    fn probe(&self, path: &Path) -> Result<Probe> {
        // ffprobe answers "invalid data" for a missing file too; stat first so the user gets
        // the real reason
        std::fs::metadata(path).at(path)?;

        let out = Command::new(&self.ffprobe)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(path)
            .output()
            .map_err(|e| map_spawn(&self.ffprobe, e))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            // mp4 writes its index last, so an interrupted recording has no moov atom. this
            // is the ordinary "obs died mid-meeting" case, not a corrupt file.
            return Err(if stderr.contains("moov atom not found") {
                Error::Truncated {
                    path: path.to_path_buf(),
                }
            } else {
                Error::Probe {
                    path: path.to_path_buf(),
                    reason: stderr
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("ffprobe failed")
                        .trim()
                        .to_string(),
                }
            });
        }

        let raw: RawProbe = serde_json::from_slice(&out.stdout).map_err(|e| Error::Probe {
            path: path.to_path_buf(),
            reason: format!("unreadable ffprobe output: {e}"),
        })?;

        let mut audio = Vec::new();
        let mut has_video = false;
        for stream in &raw.streams {
            match stream.codec_type.as_str() {
                // attached cover art is a video stream by ffprobe's reckoning; ignore it
                "video" if stream.disposition.attached_pic == 0 => has_video = true,
                "audio" => {
                    let audio_index = audio.len() as u32;
                    audio.push(AudioStream {
                        index: stream.index,
                        audio_index,
                        codec: stream.codec_name.clone().unwrap_or_else(|| "?".into()),
                        channels: stream.channels.unwrap_or(0),
                        sample_rate: stream
                            .sample_rate
                            .as_deref()
                            .and_then(|r| r.parse().ok())
                            .unwrap_or(0),
                        title: stream.tags.get("title").cloned(),
                        language: stream.tags.get("language").cloned(),
                    });
                }
                _ => {}
            }
        }

        if audio.is_empty() {
            return Err(Error::NoAudio {
                path: path.to_path_buf(),
            });
        }

        // a still-recording or interrupted file reports no duration; treating that as
        // truncated is what lets the watcher wait instead of transcribing a partial file
        let duration_ms = raw
            .format
            .as_ref()
            .and_then(|f| f.duration.as_deref())
            .and_then(|d| d.parse::<f64>().ok())
            .filter(|d| d.is_finite() && *d > 0.0)
            .map(|d| (d * 1000.0).round() as u64);
        if duration_ms.is_none() {
            return Err(Error::Truncated {
                path: path.to_path_buf(),
            });
        }

        Ok(Probe {
            container: raw
                .format
                .as_ref()
                .map_or_else(|| "?".into(), |f| f.format_name.clone()),
            duration_ms,
            has_video,
            audio,
        })
    }

    fn extract_pcm(
        &self,
        path: &Path,
        audio_index: u32,
        out: &Path,
        progress: &dyn Fn(f32),
        cancel: &CancelToken,
    ) -> Result<()> {
        cancel.check()?;
        let total_ms = self.probe(path)?.duration_ms.unwrap_or(0);

        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).at(parent)?;
        }

        let mut child = Command::new(&self.ffmpeg)
            .args(["-nostdin", "-v", "error", "-progress", "pipe:1", "-y", "-i"])
            .arg(path)
            .args([
                "-map",
                &format!("0:a:{audio_index}"),
                "-vn",
                "-sn",
                "-dn",
                "-ac",
                "1",
                "-ar",
                &TARGET_SAMPLE_RATE.to_string(),
                "-acodec",
                "pcm_s16le",
                "-f",
                "s16le",
            ])
            .arg(out)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| map_spawn(&self.ffmpeg, e))?;

        // stderr must be drained concurrently or ffmpeg blocks on a full pipe and we deadlock
        let mut stderr = child.stderr.take().expect("stderr piped");
        let drain = std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf);
            buf
        });

        let stdout = BufReader::new(child.stdout.take().expect("stdout piped"));
        let mut cancelled = false;
        for line in stdout.lines() {
            let Ok(line) = line else { break };
            if let Some(done_ms) = progress_ms(&line)
                && total_ms > 0
            {
                progress((done_ms as f32 / total_ms as f32).clamp(0.0, 1.0));
            }
            if cancel.is_cancelled() {
                cancelled = true;
                let _ = child.kill();
                break;
            }
        }

        let status = child.wait().map_err(|e| map_spawn(&self.ffmpeg, e))?;
        let stderr = drain.join().unwrap_or_default();

        if cancelled {
            discard(out);
            return Err(Error::Cancelled);
        }
        if !status.success() {
            discard(out);
            let tail = stderr.trim().lines().next_back().unwrap_or("no output");
            return Err(Error::Ffmpeg(format!("{}: {tail}", path.display())));
        }

        progress(1.0);
        debug!(file = %path.display(), track = audio_index, "extracted pcm");
        Ok(())
    }
}

/// ffmpeg's `-progress` stream is `key=value` lines; `out_time_us` is authoritative,
/// `out_time_ms` is a misnomer that also holds microseconds on older builds.
fn progress_ms(line: &str) -> Option<u64> {
    let (key, value) = line.split_once('=')?;
    match key {
        "out_time_us" | "out_time_ms" => value.trim().parse::<u64>().ok().map(|us| us / 1000),
        _ => None,
    }
}

/// A partial pcm is worse than none: phase 04 treats an existing file as a finished one.
fn discard(out: &Path) {
    if let Err(e) = std::fs::remove_file(out)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        warn!(file = %out.display(), error = %e, "could not remove partial pcm");
    }
}

fn map_spawn(bin: &Path, e: std::io::Error) -> Error {
    if e.kind() == std::io::ErrorKind::NotFound {
        Error::FfmpegMissing
    } else {
        Error::Io {
            path: bin.to_path_buf(),
            source: e,
        }
    }
}

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: Option<RawFormat>,
}

#[derive(Deserialize)]
struct RawStream {
    index: u32,
    codec_type: String,
    codec_name: Option<String>,
    channels: Option<u16>,
    sample_rate: Option<String>,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
    #[serde(default)]
    disposition: RawDisposition,
}

#[derive(Deserialize, Default)]
struct RawDisposition {
    #[serde(default)]
    attached_pic: u8,
}

#[derive(Deserialize)]
struct RawFormat {
    format_name: String,
    duration: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_microseconds_from_the_progress_stream() {
        assert_eq!(progress_ms("out_time_us=1500000"), Some(1500));
        assert_eq!(progress_ms("out_time_ms=1500000"), Some(1500));
        assert_eq!(progress_ms("frame=12"), None);
        assert_eq!(progress_ms("out_time_us=N/A"), None);
        assert_eq!(progress_ms("progress=continue"), None);
    }

    #[test]
    fn a_missing_file_is_reported_as_such() {
        let err = FfmpegCli::discover()
            .probe(Path::new("/nonexistent-unottr.mkv"))
            .unwrap_err();
        assert!(matches!(err, Error::Io { .. }), "got {err}");
    }

    #[test]
    fn a_missing_binary_is_not_an_io_error() {
        let cli = FfmpegCli::new("unottr-no-such-ffmpeg", "unottr-no-such-ffprobe");
        assert!(matches!(cli.check(), Err(Error::FfmpegMissing)));
        // a file that exists, so we get past the stat and actually try to spawn
        assert!(matches!(
            cli.probe(Path::new("/etc/hostname")),
            Err(Error::FfmpegMissing)
        ));
    }
}
