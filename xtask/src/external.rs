//! Build-time facts from outside the product checkouts: the latest published
//! ShinkiEMU Manager release (GitHub Releases) and VNDB titles for every work
//! and release the metadata snapshot refers to. Both are fetched once by
//! `site prepare`; a failure fails the build instead of shipping guessed data.

use anyhow::{Context, Result, bail, ensure};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const GITHUB_API: &str = "https://api.github.com/repos/Project-Shinkirou/ShinkiEMU";
const DOWNLOAD_PREFIX: &str = "https://github.com/Project-Shinkirou/ShinkiEMU/releases/download/";
const VNDB_API: &str = "https://api.vndb.org/kana";
/// VNDB caps `results` at 100 per request.
const VNDB_PAGE: usize = 100;

pub const MANAGER_RELEASE_SCHEMA: &str = "shinki.portal.manager_release.v1";
pub const VNDB_SCHEMA: &str = "shinki.portal.vndb_titles.v1";

#[derive(Serialize)]
pub struct ManagerReleaseFile {
    schema: &'static str,
    release: Option<ManagerRelease>,
}

#[derive(Serialize)]
pub struct ManagerRelease {
    pub tag: String,
    pub version: String,
    pub prerelease: bool,
    pub published_at: String,
    pub html_url: String,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Serialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// GitHub's asset digest without the `sha256:` prefix, when GitHub reports one.
    pub sha256: Option<String>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    html_url: String,
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}

fn github_get(client: &Client, token: Option<&str>, url: &str) -> Result<Vec<u8>> {
    let mut request = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    crate::snapshot::read_bounded(request.send()?.error_for_status()?, 8 * 1024 * 1024)
}

/// Newest published (non-draft) `manager-v*` release, or `None` before the first one.
pub fn latest_manager_release(
    client: &Client,
    token: Option<&str>,
) -> Result<Option<ManagerRelease>> {
    let bytes = github_get(
        client,
        token,
        &format!("{GITHUB_API}/releases?per_page=100"),
    )
    .context("listing ShinkiEMU releases")?;
    let releases: Vec<GhRelease> = serde_json::from_slice(&bytes)?;
    let newest = releases
        .into_iter()
        .filter(|release| !release.draft && release.tag_name.starts_with("manager-v"))
        .filter_map(|release| release.published_at.clone().map(|at| (at, release)))
        .max_by(|(a, _), (b, _)| a.cmp(b));
    let Some((published_at, release)) = newest else {
        return Ok(None);
    };
    let version = release.tag_name["manager-v".len()..].to_owned();
    ensure!(
        !version.is_empty(),
        "release tag {} has no version",
        release.tag_name
    );
    let assets = release
        .assets
        .into_iter()
        .map(|asset| {
            ensure!(
                asset.browser_download_url
                    == format!("{DOWNLOAD_PREFIX}{}/{}", release.tag_name, asset.name),
                "release asset {} is not served from the ShinkiEMU release downloads",
                asset.name
            );
            let sha256 = match asset.digest {
                None => None,
                Some(digest) => Some(
                    digest
                        .strip_prefix("sha256:")
                        .filter(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
                        .with_context(|| format!("unexpected digest for asset {}", asset.name))?
                        .to_ascii_lowercase(),
                ),
            };
            Ok(ReleaseAsset {
                name: asset.name,
                url: asset.browser_download_url,
                size: asset.size,
                sha256,
            })
        })
        .collect::<Result<_>>()?;
    Ok(Some(ManagerRelease {
        tag: release.tag_name,
        version,
        prerelease: release.prerelease,
        published_at,
        html_url: release.html_url,
        assets,
    }))
}

pub fn manager_release_file(release: Option<ManagerRelease>) -> ManagerReleaseFile {
    ManagerReleaseFile {
        schema: MANAGER_RELEASE_SCHEMA,
        release,
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Title {
    /// VNDB main title (romanized when the original script is not Latin).
    pub title: String,
    /// Title in the original script, when it differs.
    pub alttitle: Option<String>,
}

#[derive(Serialize)]
pub struct VndbTitles {
    schema: &'static str,
    vn: BTreeMap<String, Title>,
    release: BTreeMap<String, Title>,
}

#[derive(Deserialize)]
struct VndbPage {
    results: Vec<VndbItem>,
}

#[derive(Deserialize)]
struct VndbItem {
    id: String,
    title: String,
    alttitle: Option<String>,
}

fn vndb_query(
    client: &Client,
    endpoint: &str,
    ids: &BTreeSet<String>,
) -> Result<BTreeMap<String, Title>> {
    let mut titles = BTreeMap::new();
    let ids: Vec<&String> = ids.iter().collect();
    for chunk in ids.chunks(VNDB_PAGE) {
        let filters: Vec<Value> = chunk.iter().map(|id| json!(["id", "=", id])).collect();
        let filters = if filters.len() == 1 {
            filters.into_iter().next().unwrap()
        } else {
            let mut or = vec![json!("or")];
            or.extend(filters);
            Value::Array(or)
        };
        let response = client
            .post(format!("{VNDB_API}/{endpoint}"))
            .json(&json!({ "filters": filters, "fields": "title, alttitle", "results": VNDB_PAGE }))
            .send()
            .with_context(|| format!("querying VNDB /{endpoint}"))?
            .error_for_status()
            .with_context(|| format!("VNDB /{endpoint} request failed"))?;
        let page: VndbPage =
            serde_json::from_slice(&crate::snapshot::read_bounded(response, 4 * 1024 * 1024)?)?;
        for item in page.results {
            let alttitle = item
                .alttitle
                .filter(|alt| !alt.trim().is_empty() && *alt != item.title);
            titles.insert(
                item.id,
                Title {
                    title: item.title,
                    alttitle,
                },
            );
        }
    }
    let missing: Vec<&str> = ids
        .iter()
        .filter(|id| !titles.contains_key(id.as_str()))
        .map(|id| id.as_str())
        .collect();
    if !missing.is_empty() {
        bail!("VNDB /{endpoint} has no entry for {}", missing.join(", "));
    }
    Ok(titles)
}

/// Every `vn_id`/`release_id` referenced by compatibility reports and patches.
pub fn referenced_ids(
    compatibility: &Value,
    patches: &Value,
) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    let mut vn = BTreeSet::new();
    let mut release = BTreeSet::new();
    let entries = |value: &Value, name: &str| -> Result<Vec<Value>> {
        value["entries"]
            .as_array()
            .cloned()
            .with_context(|| format!("{name} has no entries array"))
    };
    for entry in entries(compatibility, "compatibility.json")? {
        vn.insert(
            entry["vn_id"]
                .as_str()
                .context("compatibility vn_id")?
                .to_owned(),
        );
        release.insert(
            entry["release_id"]
                .as_str()
                .context("compatibility release_id")?
                .to_owned(),
        );
    }
    for entry in entries(patches, "patches.json")? {
        for id in entry["vn_ids"].as_array().context("patch vn_ids")? {
            vn.insert(id.as_str().context("patch vn_id")?.to_owned());
        }
        for id in entry["release_ids"]
            .as_array()
            .context("patch release_ids")?
        {
            release.insert(id.as_str().context("patch release_id")?.to_owned());
        }
    }
    Ok((vn, release))
}

pub fn vndb_titles(
    client: &Client,
    vn: &BTreeSet<String>,
    release: &BTreeSet<String>,
) -> Result<VndbTitles> {
    Ok(VndbTitles {
        schema: VNDB_SCHEMA,
        vn: vndb_query(client, "vn", vn)?,
        release: vndb_query(client, "release", release)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referenced_ids_cover_reports_and_patch_scopes() {
        let compatibility = json!({"entries": [{"vn_id": "v2", "release_id": "r3"}]});
        let patches = json!({"entries": [{"vn_ids": ["v2", "v5"], "release_ids": []}]});
        let (vn, release) = referenced_ids(&compatibility, &patches).unwrap();
        assert_eq!(vn.into_iter().collect::<Vec<_>>(), ["v2", "v5"]);
        assert_eq!(release.into_iter().collect::<Vec<_>>(), ["r3"]);
    }

    #[test]
    fn referenced_ids_reject_malformed_entries() {
        let compatibility = json!({"entries": [{"vn_id": 7, "release_id": "r3"}]});
        assert!(referenced_ids(&compatibility, &json!({"entries": []})).is_err());
    }
}
