use anyhow::{Context, Result, ensure};
use reqwest::{Url, blocking::Response};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, io::Read};

const MAX_FILE: u64 = 8 * 1024 * 1024;
const MAX_TOTAL: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 4096;

// Mirrors ShinkiEMU's public metadata index contract without coupling the portal
// build tool to the emulator workspace or its native build dependencies.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    schema: String,
    generated_at_unix_ms: i64,
    source_commit: String,
    files: Vec<IndexedFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexedFile {
    path: String,
    sha256: String,
    size: u64,
}

fn lowercase_hex(value: &str) -> bool {
    value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn is_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && lowercase_hex(value)
}

fn safe_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 256 && path != "index.json" && !path.contains("..")
        && path.split('/').all(|part| {
            !part.is_empty() && part != "."
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
        })
}

fn parse_index(bytes: &[u8]) -> Result<Index> {
    ensure!(bytes.len() as u64 <= MAX_FILE, "index exceeds 8 MiB");
    // Direct struct deserialization also rejects duplicate and unknown fields.
    let index: Index = serde_json::from_slice(bytes).context("decoding index.json")?;
    ensure!(index.schema == "shinki.emu.metadata.index.v1", "unknown index schema");
    ensure!(index.generated_at_unix_ms >= 0 && is_commit(&index.source_commit), "invalid index source identity");
    ensure!(index.files.len() <= MAX_FILES, "index exceeds 4096 files");
    let mut paths = BTreeSet::new();
    let mut total = 0;
    for file in &index.files {
        ensure!(safe_path(&file.path), "unsafe indexed path: {}", file.path);
        ensure!(file.sha256.len() == 64 && lowercase_hex(&file.sha256), "invalid sha256: {}", file.path);
        ensure!(file.size <= MAX_FILE, "indexed file exceeds 8 MiB: {}", file.path);
        total += file.size;
        ensure!(total <= MAX_TOTAL, "indexed files exceed 64 MiB");
        ensure!(paths.insert(file.path.to_ascii_lowercase()), "duplicate indexed path: {}", file.path);
    }
    Ok(index)
}

pub fn read_bounded(response: Response, limit: u64) -> Result<Vec<u8>> {
    if let Some(length) = response.content_length() {
        ensure!(length <= limit, "HTTP response exceeds byte limit {limit}");
    }
    read_limited(response, limit)
}

fn read_limited(reader: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "response exceeds byte limit {limit}");
    Ok(bytes)
}

fn verify_files<R: Read>(index: &Index, mut fetch: impl FnMut(&IndexedFile) -> Result<R>) -> Result<()> {
    for file in &index.files {
        let mut reader = fetch(file)?.take(file.size + 1);
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 16384];
        let mut size = 0;
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 { break; }
            size += count as u64;
            ensure!(size <= file.size, "size mismatch for {}", file.path);
            hasher.update(&buffer[..count]);
        }
        ensure!(size == file.size, "size mismatch for {}: {size} != {}", file.path, file.size);
        ensure!(hex::encode(hasher.finalize()) == file.sha256, "sha256 mismatch for {}", file.path);
    }
    Ok(())
}

pub fn verify(base_url: &str) -> Result<()> {
    let base = Url::parse(base_url)?;
    ensure!(matches!(base.scheme(), "http" | "https") && base.host_str().is_some()
        && base.username().is_empty() && base.password().is_none()
        && base.query().is_none() && base.fragment().is_none(), "base URL must be an HTTP(S) site URL without credentials, query or fragment");
    let snapshot = Url::parse(&format!("{}/data/shinkiemu/v1/", base.as_str().trim_end_matches('/')))?;
    let client = crate::site::http_client()?;
    let bytes = read_bounded(client.get(snapshot.join("index.json")?).send()?.error_for_status()?, MAX_FILE)?;
    let index = parse_index(&bytes)?;
    verify_files(&index, |file| {
        let response = client.get(snapshot.join(&file.path)?).send()?.error_for_status()?;
        if let Some(length) = response.content_length() {
            ensure!(length == file.size, "size mismatch for {}: {length} != {}", file.path, file.size);
        }
        Ok(response)
    })?;
    println!("Verified {} deployed metadata files from {}", index.files.len(), snapshot);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::fs;

    fn index(files: Value) -> Value {
        json!({"schema":"shinki.emu.metadata.index.v1", "source_commit":"a".repeat(40), "generated_at_unix_ms":0, "files":files})
    }

    fn entry(path: &str, bytes: &[u8]) -> Value {
        json!({"path":path, "sha256":hex::encode(Sha256::digest(bytes)), "size":bytes.len()})
    }

    fn fixture(index: &Value, files: &[(&str, &[u8])]) -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::write(temp.path().join("index.json"), serde_json::to_vec(index)?)?;
        for (path, bytes) in files {
            let path = temp.path().join(path);
            fs::create_dir_all(path.parent().unwrap())?;
            fs::write(path, bytes)?;
        }
        let index = parse_index(&fs::read(temp.path().join("index.json"))?)?;
        verify_files(&index, |file| Ok(fs::File::open(temp.path().join(&file.path))?))
    }

    #[test]
    fn checks_every_file_including_nested_paths() {
        fixture(&index(json!([entry("one.json", b"one"), entry("nested/two.json", b"two")])),
            &[("one.json", b"one"), ("nested/two.json", b"two")]).unwrap();
        // A corrupt second file proves verification does not stop at the first.
        let error = fixture(&index(json!([entry("one.json", b"one"), entry("nested/two.json", b"two")])),
            &[("one.json", b"one"), ("nested/two.json", b"bad")]).unwrap_err();
        assert!(error.to_string().contains("sha256 mismatch"));
    }

    #[test]
    fn rejects_hash_and_size_mismatches_and_missing_files() {
        let error = fixture(&index(json!([entry("one.json", b"one")])), &[("one.json", b"bad")]).unwrap_err();
        assert!(error.to_string().contains("sha256 mismatch"));
        for actual in [&b"x"[..], &b"longer"[..]] {
            let error = fixture(&index(json!([entry("one.json", b"one")])), &[("one.json", actual)]).unwrap_err();
            assert!(error.to_string().contains("size mismatch"));
        }
        assert!(fixture(&index(json!([entry("missing.json", b"one")])), &[]).is_err());
    }

    #[test]
    fn rejects_unsafe_and_case_colliding_paths() {
        for path in ["../outside", "/absolute", "a/../../b", "a\\b", "a:b", "a%2fb", "a//b", ".", "index.json"] {
            let error = fixture(&index(json!([entry(path, b"one")])), &[]).unwrap_err();
            assert!(error.to_string().contains("unsafe indexed path"), "accepted {path}");
        }
        let error = fixture(&index(json!([entry("one.json", b"one"), entry("ONE.json", b"one")])), &[]).unwrap_err();
        assert!(error.to_string().contains("duplicate indexed path"));
    }

    #[test]
    fn rejects_file_total_and_count_limits() {
        let oversized = json!({"path":"huge.json", "sha256":"a".repeat(64), "size":MAX_FILE+1});
        assert!(fixture(&index(json!([oversized])), &[]).unwrap_err().to_string().contains("exceeds 8 MiB"));
        let files: Vec<_> = (0..9).map(|n| json!({"path":format!("{n}.json"), "sha256":"a".repeat(64), "size":MAX_FILE})).collect();
        assert!(fixture(&index(json!(files)), &[]).unwrap_err().to_string().contains("exceed 64 MiB"));
        let files: Vec<_> = (0..=MAX_FILES).map(|n| entry(&format!("{n}.json"), b"")).collect();
        assert!(fixture(&index(json!(files)), &[]).unwrap_err().to_string().contains("exceeds 4096 files"));
    }

    #[test]
    fn rejects_oversized_streams_even_when_index_claims_small_file() {
        let bytes = vec![0; MAX_FILE as usize + 1];
        let error = fixture(&index(json!([entry("huge.json", b"one")])), &[("huge.json", &bytes)]).unwrap_err();
        assert!(error.to_string().contains("size mismatch"));
        // The same bounded reader is used for HTTP bodies without Content-Length.
        assert!(read_limited(bytes.as_slice(), MAX_FILE).is_err());
        assert!(parse_index(&bytes).is_err());
    }

    #[test]
    fn rejects_duplicate_json_fields() {
        let bytes = br#"{"schema":"shinki.emu.metadata.index.v1","generated_at_unix_ms":0,"source_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":[],"files":[]}"#;
        assert!(parse_index(bytes).is_err());
    }
}
