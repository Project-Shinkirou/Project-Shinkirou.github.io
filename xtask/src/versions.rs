//! Version of every core in ShinkiEMU `build/cores.toml`, read from the core's
//! Cargo manifest at the exact revision the product builds: organization forks
//! at their pinned `[cores.source].rev` (through the GitHub API), owned cores
//! at the prepared ShinkiEMU commit. Workspace-inherited versions are resolved
//! like Cargo does; a manifest without a version fails the build instead of
//! publishing a guess.

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
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CoreVersion {
    pub version: String,
    /// Commit the manifest was read at: the fork pin, or the ShinkiEMU commit for owned cores.
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
    },
}

fn location(core: &InventoryCore) -> Result<Location<'_>> {
    let Some(source) = &core.source else {
        return Ok(Location::Owned {
            manifest: &core.manifest,
        });
    };
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
            } => CoreVersion {
                version: resolve_version(&manifest, &mut |path| {
                    fork_file(client, token, repo, rev, path)
                })
                .with_context(|| format!("core {} at {repo}@{rev}", core.id))?,
                rev: rev.to_owned(),
            },
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
            }),
        };
        assert_eq!(
            location(&core).unwrap(),
            Location::Fork {
                repo: "rfvp",
                rev: "7c241b477fb10efd981b20af67b1fb9745ec97fe",
                manifest: "crates/shinki-emu-rfvp/Cargo.toml".into(),
            }
        );
        let foreign = InventoryCore {
            source: Some(InventorySource {
                repo: "https://github.com/xmoezzz/rfvp".into(),
                rev: core.source.as_ref().unwrap().rev.clone(),
            }),
            ..core
        };
        assert!(location(&foreign).is_err());
    }
}
