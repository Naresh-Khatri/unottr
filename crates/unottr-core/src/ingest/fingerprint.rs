use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::error::{IoResultExt, Result};

/// Bytes hashed from each end. 1 MiB is enough to distinguish real files cheaply, constant
/// regardless of the multi-GB recordings in the corpus (decision #22).
const CHUNK: u64 = 1 << 20;

/// `(size, blake3(first 1 MiB), blake3(last 1 MiB))`. Identity for a file independent of its
/// path — what lets a moved/renamed file re-link instead of reprocessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub head: [u8; 32],
    pub tail: [u8; 32],
}

pub fn compute(path: &Path) -> Result<Fingerprint> {
    let mut file = File::open(path).at(path)?;
    let size = file.metadata().at(path)?.len();

    let mut buf = vec![0u8; CHUNK.min(size) as usize];
    file.read_exact(&mut buf).at(path)?;
    let head = *blake3::hash(&buf).as_bytes();

    let tail_len = CHUNK.min(size) as usize;
    file.seek(SeekFrom::End(-(tail_len as i64))).at(path)?;
    let mut buf = vec![0u8; tail_len];
    file.read_exact(&mut buf).at(path)?;
    let tail = *blake3::hash(&buf).as_bytes();

    Ok(Fingerprint { size, head, tail })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_bytes_fingerprint_identically() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&a, b"hello world").unwrap();
        std::fs::write(&b, b"hello world").unwrap();
        assert_eq!(compute(&a).unwrap(), compute(&b).unwrap());
    }

    #[test]
    fn a_single_byte_difference_changes_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&a, b"hello world").unwrap();
        std::fs::write(&b, b"hello worlD").unwrap();
        assert_ne!(compute(&a).unwrap(), compute(&b).unwrap());
    }

    #[test]
    fn files_smaller_than_the_chunk_still_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tiny");
        std::fs::write(&path, b"x").unwrap();
        let fp = compute(&path).unwrap();
        assert_eq!(fp.size, 1);
        assert_eq!(fp.head, fp.tail);
    }

    #[test]
    fn files_larger_than_two_chunks_hash_only_the_ends() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        let mut big = vec![0u8; (3 * CHUNK) as usize];
        let len = big.len();
        big[..4].copy_from_slice(b"head");
        big[len - 4..].copy_from_slice(b"tail");
        std::fs::write(&a, &big).unwrap();
        // differs only in the untouched middle
        big[(1.5 * CHUNK as f64) as usize] = 0xff;
        std::fs::write(&b, &big).unwrap();

        assert_eq!(compute(&a).unwrap(), compute(&b).unwrap());
    }
}
