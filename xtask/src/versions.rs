//! Version of every core in ShinkiEMU `build/cores.toml`. Legacy and owned
//! cores read `[package].version` from the Cargo manifest at the exact
//! revision the product builds: organization forks at their pinned
//! `[cores.source].rev` (through the GitHub API), owned cores at the prepared
//! ShinkiEMU commit. A fork carrying `[cores.source].upstream_identity` and
//! `release_sequence` uses the readable upstream-ref label instead, because a
//! Cargo version would hide which upstream ref the adapter actually builds.
//! Workspace-inherited versions are resolved like Cargo does; a manifest
//! without a version fails the build instead of publishing a guess.
//! Typed source declarations must agree with `source.upstream`, and use the
//! same bounded Git-ref/repository validation as the metadata consumer.

use anyhow::{Context, Result, bail, ensure};
use reqwest::{StatusCode, blocking::Client};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
use toml::{Table, Value};

pub const CORE_VERSIONS_SCHEMA: &str = "shinki.portal.core_versions.v1";
const FORK_PREFIX: &str = "https://github.com/Project-Shinkirou/";
const MAX_MANIFEST: u64 = 1024 * 1024;

#[derive(Deserialize)]
struct Inventory {
    cores: Vec<InventoryCore>,
}

#[derive(Deserialize)]
struct InventoryCore {
    id: String,
    manifest: String,
    source: Option<InventorySource>,
}

#[derive(Deserialize)]
struct InventorySource {
    repo: String,
    rev: String,
    branch: Option<String>,
    upstream: Option<String>,
    upstream_identity: Option<UpstreamIdentity>,
    release_sequence: Option<u64>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct UpstreamIdentity {
    repo: String,
    ref_kind: String,
    ref_name: String,
    commit: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CoreVersion {
    pub version: String,
    /// Exact adapter fork pin, or the ShinkiEMU commit for owned cores.
    pub rev: String,
}

#[derive(Serialize)]
pub struct CoreVersions {
    schema: &'static str,
    cores: BTreeMap<String, CoreVersion>,
}

/// Where a core's manifest lives: the ShinkiEMU checkout or an organization fork.
#[derive(Debug, PartialEq)]
enum Location<'a> {
    Owned {
        manifest: &'a str,
    },
    Fork {
        repo: &'a str,
        rev: &'a str,
        manifest: String,
        branch: Option<&'a str>,
        upstream_identity: Option<&'a UpstreamIdentity>,
        release_sequence: Option<u64>,
    },
}

fn github_repo(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://github.com/") else {
        return false;
    };
    let mut parts = rest.split('/');
    let safe = |part: &str| {
        !part.is_empty() && part != "." && part != ".." && part.len() <= 100
            && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    };
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(owner), Some(name), None) if safe(owner) && safe(name)
            && !name.get(name.len().saturating_sub(4)..).is_some_and(|suffix| suffix.eq_ignore_ascii_case(".git"))
    )
}

fn git_ref(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains("..") && !value.contains("@{")
        && value != "@" && !value.ends_with('.')
        && value.split('/').all(|part| {
            !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock")
                && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-+".contains(&byte))
        })
}

/// Readable label for a third-party release: the raw upstream ref, both short
/// commits and no synthetic version number. Ordering lives in the catalog's
/// `release_sequence`, not in this text.
fn external_version(
    core_id: &str,
    upstream: &UpstreamIdentity,
    branch: Option<&str>,
    adapter_rev: &str,
    release_sequence: Option<u64>,
) -> Result<String> {
    let sequence = release_sequence
        .with_context(|| format!("core {core_id} upstream_identity needs release_sequence"))?;
    ensure!(
        (1..=9_007_199_254_740_991).contains(&sequence),
        "core {core_id} release_sequence is out of range"
    );
    ensure!(
        matches!(upstream.ref_kind.as_str(), "tag" | "branch"),
        "core {core_id} upstream ref_kind is not tag or branch"
    );
    ensure!(
        git_ref(&upstream.ref_name),
        "core {core_id} upstream ref_name is not a safe Git ref"
    );
    ensure!(
        github_repo(&upstream.repo) && !upstream.repo.strip_prefix("https://github.com/")
            .and_then(|path| path.split_once('/'))
            .is_some_and(|(owner, _)| owner.eq_ignore_ascii_case("Project-Shinkirou")),
        "core {core_id} upstream repo is not an original GitHub repository"
    );
    ensure!(
        upstream.commit.len() == 40 && crate::snapshot::is_commit(&upstream.commit),
        "core {core_id} upstream commit is not a 40-character commit"
    );
    ensure!(
        adapter_rev.len() == 40 && crate::snapshot::is_commit(adapter_rev),
        "core {core_id} adapter commit is not a 40-character commit"
    );
    let branch =
        branch.with_context(|| format!("core {core_id} upstream_identity needs source.branch"))?;
    ensure!(
        git_ref(branch),
        "core {core_id} adapter branch is not a safe Git ref"
    );
    Ok(format!(
        "{}@{} (adapter {})",
        upstream.ref_name,
        &upstream.commit[..12],
        &adapter_rev[..12]
    ))
}

fn location(core: &InventoryCore) -> Result<Location<'_>> {
    let Some(source) = &core.source else {
        return Ok(Location::Owned {
            manifest: &core.manifest,
        });
    };
    ensure!(github_repo(&source.repo), "core {} source is not a safe GitHub repository", core.id);
    if let Some(upstream) = &source.upstream_identity {
        ensure!(source.upstream.as_deref() == Some(upstream.repo.as_str()),
            "core {} upstream identity disagrees with source.upstream", core.id);
    }
    let repo = source
        .repo
        .strip_prefix(FORK_PREFIX)
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .with_context(|| format!("core {} source is not an organization repository", core.id))?;
    ensure!(
        crate::snapshot::is_commit(&source.rev),
        "core {} source rev is not a commit",
        core.id
    );
    // `ThirdParty/<checkout>/<path in fork>`; the checkout directory may differ from the repository name.
    let mut parts = core.manifest.splitn(3, '/');
    let (Some("ThirdParty"), Some(_), Some(inner)) = (parts.next(), parts.next(), parts.next())
    else {
        bail!(
            "core {} fork manifest must be under ThirdParty/<checkout>/",
            core.id
        );
    };
    Ok(Location::Fork {
        repo,
        rev: &source.rev,
        manifest: inner.to_owned(),
        branch: source.branch.as_deref(),
        upstream_identity: source.upstream_identity.as_ref(),
        release_sequence: source.release_sequence,
    })
}

fn parse(text: &str, path: &str) -> Result<Table> {
    text.parse::<Table>()
        .with_context(|| format!("parsing {path}"))
}

/// `[package].version` of `manifest`, following `version.workspace = true` to
/// the nearest enclosing workspace root (the manifest itself included).
fn resolve_version(
    manifest: &str,
    read: &mut dyn FnMut(&str) -> Result<Option<String>>,
) -> Result<String> {
    let text = read(manifest)?.with_context(|| format!("{manifest} does not exist"))?;
    let table = parse(&text, manifest)?;
    let package = table
        .get("package")
        .and_then(Value::as_table)
        .with_context(|| format!("{manifest} has no [package]"))?;
    ensure!(
        package.get("workspace").is_none(),
        "{manifest} sets package.workspace; explicit workspace roots are not resolved"
    );
    let inherited = match package.get("version") {
        Some(Value::String(version)) => return checked(version, manifest),
        Some(Value::Table(version)) => {
            version.get("workspace").and_then(Value::as_bool) == Some(true)
        }
        _ => false,
    };
    ensure!(inherited, "{manifest} has no package version");
    let mut dir = Path::new(manifest).parent();
    let mut candidate = Some(table);
    let mut path = manifest.to_owned();
    loop {
        if let Some(root) = candidate
            .take()
            .and_then(|table| table.get("workspace").cloned())
        {
            let version = root
                .get("package")
                .and_then(|package| package.get("version"))
                .and_then(Value::as_str)
                .with_context(|| {
                    format!("workspace root {path} has no [workspace.package].version")
                })?;
            return checked(version, &path);
        }
        let Some(current) = dir else {
            bail!("{manifest} inherits its version but no enclosing workspace root was found");
        };
        dir = current.parent();
        let Some(parent) = dir else {
            bail!("{manifest} inherits its version but no enclosing workspace root was found");
        };
        path = if parent.as_os_str().is_empty() {
            "Cargo.toml".to_owned()
        } else {
            format!("{}/Cargo.toml", parent.to_string_lossy().replace('\\', "/"))
        };
        candidate = read(&path)?.map(|text| parse(&text, &path)).transpose()?;
    }
}

fn checked(version: &str, path: &str) -> Result<String> {
    ensure!(
        !version.is_empty() && version.len() <= 64,
        "{path} has an invalid version"
    );
    Ok(version.to_owned())
}

fn fork_file(
    client: &Client,
    token: Option<&str>,
    repo: &str,
    rev: &str,
    path: &str,
) -> Result<Option<String>> {
    let url =
        format!("https://api.github.com/repos/Project-Shinkirou/{repo}/contents/{path}?ref={rev}");
    let mut request = client
        .get(&url)
        .header("Accept", "application/vnd.github.raw+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .with_context(|| format!("fetching {repo}@{rev}:{path}"))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let bytes = crate::snapshot::read_bounded(
        response
            .error_for_status()
            .with_context(|| format!("fetching {repo}@{rev}:{path}"))?,
        MAX_MANIFEST,
    )?;
    Ok(Some(String::from_utf8(bytes).with_context(|| {
        format!("{repo}@{rev}:{path} is not UTF-8")
    })?))
}

fn owned_file(shinkiemu: &Path, commit: &str, path: &str) -> Result<Option<String>> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(shinkiemu)
        .args(["cat-file", "blob", &format!("{commit}:{path}")])
        .output()
        .context("running git cat-file")?;
    if !output.status.success() {
        // Distinguish a missing path from a broken repository.
        let exists = std::process::Command::new("git")
            .arg("-C")
            .arg(shinkiemu)
            .args(["cat-file", "-e", commit])
            .status()?
            .success();
        ensure!(exists, "ShinkiEMU commit {commit} is not available");
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8(output.stdout).with_context(|| format!("{path} is not UTF-8"))?,
    ))
}

pub fn core_versions(
    shinkiemu: &Path,
    shinkiemu_commit: &str,
    inventory: &str,
    client: &Client,
    token: Option<&str>,
) -> Result<CoreVersions> {
    let inventory: Inventory = toml::from_str(inventory).context("parsing build/cores.toml")?;
    let mut cores = BTreeMap::new();
    for core in &inventory.cores {
        let resolved = match location(core)? {
            Location::Owned { manifest } => CoreVersion {
                version: resolve_version(manifest, &mut |path| {
                    owned_file(shinkiemu, shinkiemu_commit, path)
                })?,
                rev: shinkiemu_commit.to_owned(),
            },
            Location::Fork {
                repo,
                rev,
                manifest,
                branch,
                upstream_identity,
                release_sequence,
            } => {
                let version = match upstream_identity {
                    Some(upstream) => {
                        external_version(&core.id, upstream, branch, rev, release_sequence)?
                    }
                    None => {
                        ensure!(
                            release_sequence.is_none(),
                            "core {} has release_sequence without upstream_identity",
                            core.id
                        );
                        resolve_version(&manifest, &mut |path| fork_file(client, token, repo, rev, path))
                            .with_context(|| format!("core {} at {repo}@{rev}", core.id))?
                    }
                };
                CoreVersion {
                    version,
                    rev: rev.to_owned(),
                }
            }
        };
        ensure!(
            cores.insert(core.id.clone(), resolved).is_none(),
            "duplicate core {}",
            core.id
        );
    }
    Ok(CoreVersions {
        schema: CORE_VERSIONS_SCHEMA,
        cores,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reader(files: &[(&str, &str)]) -> impl FnMut(&str) -> Result<Option<String>> {
        let files: BTreeMap<String, String> = files
            .iter()
            .map(|(path, text)| ((*path).to_owned(), (*text).to_owned()))
            .collect();
        move |path| Ok(files.get(path).cloned())
    }

    #[test]
    fn literal_version() {
        let mut read = reader(&[(
            "crates/core/Cargo.toml",
            "[package]\nname = \"core\"\nversion = \"0.6.0\"\n",
        )]);
        assert_eq!(
            resolve_version("crates/core/Cargo.toml", &mut read).unwrap(),
            "0.6.0"
        );
    }

    #[test]
    fn inherited_version_uses_nearest_workspace_root() {
        let mut read = reader(&[
            (
                "Source/Families/musica/Cargo.toml",
                "[package]\nname = \"m\"\nversion.workspace = true\n",
            ),
            (
                "Source/Cargo.toml",
                "[package]\nname = \"not-a-root\"\nversion = \"9.9.9\"\n",
            ),
            (
                "Cargo.toml",
                "[workspace]\nmembers = []\n[workspace.package]\nversion = \"0.1.0\"\n",
            ),
        ]);
        assert_eq!(
            resolve_version("Source/Families/musica/Cargo.toml", &mut read).unwrap(),
            "0.1.0"
        );
    }

    #[test]
    fn manifest_can_be_its_own_workspace_root() {
        let mut read = reader(&[(
            "shinki/Cargo.toml",
            "[package]\nname = \"k\"\nversion = { workspace = true }\n[workspace]\n[workspace.package]\nversion = \"2.0.0\"\n",
        )]);
        assert_eq!(
            resolve_version("shinki/Cargo.toml", &mut read).unwrap(),
            "2.0.0"
        );
    }

    #[test]
    fn missing_versions_fail() {
        let mut read = reader(&[("a/Cargo.toml", "[package]\nname = \"a\"\n")]);
        assert!(resolve_version("a/Cargo.toml", &mut read).is_err());
        let mut read = reader(&[(
            "a/Cargo.toml",
            "[package]\nname = \"a\"\nversion.workspace = true\n",
        )]);
        assert!(resolve_version("a/Cargo.toml", &mut read).is_err());
        assert!(resolve_version("missing/Cargo.toml", &mut reader(&[])).is_err());
    }

    #[test]
    fn fork_manifests_resolve_inside_the_fork() {
        let core = InventoryCore {
            id: "rfvp".into(),
            manifest: "ThirdParty/rfvp/crates/shinki-emu-rfvp/Cargo.toml".into(),
            source: Some(InventorySource {
                repo: "https://github.com/Project-Shinkirou/rfvp".into(),
                rev: "7c241b477fb10efd981b20af67b1fb9745ec97fe".into(),
                branch: Some("shinki".into()),
                upstream: Some("https://github.com/xmoezzz/rfvp".into()),
                upstream_identity: None,
                release_sequence: None,
            }),
        };
        assert_eq!(
            location(&core).unwrap(),
            Location::Fork {
                repo: "rfvp",
                rev: "7c241b477fb10efd981b20af67b1fb9745ec97fe",
                manifest: "crates/shinki-emu-rfvp/Cargo.toml".into(),
                branch: Some("shinki"),
                upstream_identity: None,
                release_sequence: None,
            }
        );
        let foreign = InventoryCore {
            source: Some(InventorySource {
                repo: "https://github.com/xmoezzz/rfvp".into(),
                rev: core.source.as_ref().unwrap().rev.clone(),
                branch: None,
                upstream: None,
                upstream_identity: None,
                release_sequence: None,
            }),
            ..core
        };
        assert!(location(&foreign).is_err());
    }

    fn external_inventory() -> Value {
        toml::from_str(r#"
[[cores]]
id = "rfvp"
manifest = "ThirdParty/rfvp/crates/shinki-emu-rfvp/Cargo.toml"
[cores.source]
repo = "https://github.com/Project-Shinkirou/rfvp"
branch = "shinki"
rev = "9a5c20026e3638ef5714c2ad7062634648c8dfcf"
upstream = "https://github.com/xmoezzz/rfvp"
release_sequence = 1
upstream_identity = { repo = "https://github.com/xmoezzz/rfvp", ref_kind = "tag", ref_name = "0.7.0", commit = "99435f22e94eaec27c0c1b9f22cc2a6b1910d7d1" }
"#).unwrap()
    }

    fn produce(inventory: &Value) -> Result<CoreVersions> {
        let core = &inventory["cores"][0];
        let source = core["source"].as_table().unwrap();
        let mut input = format!("[[cores]]\nid = {}\nmanifest = {}\n[cores.source]\n",
            serde_json::to_string(&core["id"])?, serde_json::to_string(&core["manifest"])?);
        for (name, value) in source {
            if name != "upstream_identity" {
                input.push_str(&format!("{name} = {}\n", serde_json::to_string(value)?));
            }
        }
        input.push_str("[cores.source.upstream_identity]\n");
        for (name, value) in source["upstream_identity"].as_table().unwrap() {
            input.push_str(&format!("{name} = {}\n", serde_json::to_string(value)?));
        }
        core_versions(Path::new("."), &"f".repeat(40), &input, &Client::new(), None)
    }

    #[test]
    fn inventory_producer_preserves_tag_branch_and_adapter_only_changes() {
        let mut inventory = external_inventory();
        let tagged = produce(&inventory).unwrap();
        let source = &mut inventory["cores"][0]["source"];
        source["rev"] = "3".repeat(40).into();
        source["release_sequence"] = 2_i64.into();
        let updated = produce(&inventory).unwrap();
        assert_eq!(tagged.cores["rfvp"].rev, "9a5c20026e3638ef5714c2ad7062634648c8dfcf");
        assert!(tagged.cores["rfvp"].version.starts_with("0.7.0@99435f22e94e"));
        assert_eq!(updated.cores["rfvp"].rev, "3".repeat(40));
        assert_ne!(tagged.cores["rfvp"].version, updated.cores["rfvp"].version);
        let source = &mut inventory["cores"][0]["source"];
        source["upstream_identity"]["ref_kind"] = "branch".into();
        source["upstream_identity"]["ref_name"] = "feature/save-load".into();
        let branch = produce(&inventory).unwrap();
        assert!(branch.cores["rfvp"].version.starts_with("feature/save-load@99435f22e94e"));
    }

    #[test]
    fn inventory_producer_rejects_invalid_or_conflicting_provenance() {
        for reference in ["../next", "main/../../other", "/main", "main.lock", ".hidden/next", "main\\next", "@", "main@{1}", "main\nnext"] {
            let mut inventory = external_inventory();
            inventory["cores"][0]["source"]["upstream_identity"]["ref_name"] = reference.into();
            assert!(produce(&inventory).is_err(), "{reference}");
        }
        let mut inventory = external_inventory();
        inventory["cores"][0]["source"]["upstream_identity"]["ref_name"] = "x".repeat(256).into();
        produce(&inventory).unwrap();
        inventory["cores"][0]["source"]["upstream_identity"]["ref_name"] = "x".repeat(257).into();
        assert!(produce(&inventory).is_err());
        let mut inventory = external_inventory();
        inventory["cores"][0]["source"]["upstream"] = "https://github.com/other/engine".into();
        assert!(produce(&inventory).is_err());
        for repository in ["https://github.com/project-shinkirou/rfvp", "https://github.com/./engine", "https://github.com/example/..", "https://github.com/example/engine.git", "https://github.com/example/engine.GIT"] {
            let mut inventory = external_inventory();
            inventory["cores"][0]["source"]["upstream"] = repository.into();
            inventory["cores"][0]["source"]["upstream_identity"]["repo"] = repository.into();
            assert!(produce(&inventory).is_err(), "{repository}");
        }
        for sequence in [0_i64, 9_007_199_254_740_992] {
            let mut inventory = external_inventory();
            inventory["cores"][0]["source"]["release_sequence"] = sequence.into();
            assert!(produce(&inventory).is_err());
        }
        let mut inventory = external_inventory();
        inventory["cores"][0]["source"]["rev"] = "main".into();
        assert!(produce(&inventory).is_err());
    }
}
