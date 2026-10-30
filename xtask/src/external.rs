//! Build-time facts from outside the product checkouts: the latest published
//! ShinkiEMU Manager release (GitHub Releases), VNDB titles for every work
//! and release the metadata snapshot refers to, and VNDB release counts for
//! every engine family in `build/cores.toml`. All are fetched once by
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
pub const VNDB_COVERAGE_SCHEMA: &str = "shinki.portal.vndb_coverage.v1";

/// VNDB release `engine` strings for each `family_name` in ShinkiEMU
/// `build/cores.toml`. The strings must match vndb.org/r/engines exactly:
/// lookalikes such as `Siglus`, `Artemis`, `SoftPAL`, `BGI` or `MAGES.` match
/// no release. `RealLive` is Key's older engine, not SiglusEngine, and stays out.
const VNDB_ENGINES: &[(&str, &[&str])] = &[
    ("FVP", &["FVP"]),
    ("SiglusEngine", &["SiglusEngine"]),
    ("Artemis", &["Artemis Engine"]),
    ("Musica", &["Musica"]),
    ("SoftPAL", &["Softpal ADV System"]),
    ("KiriKiri", &["KiriKiri"]),
    ("Ethornell / BGI", &["BGI/Ethornell"]),
    ("CMVS", &["CMVS"]),
    ("MAGES.", &["MAGES. Engine"]),
    ("Ren’Py", &["Ren'Py"]),
];

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

#[derive(Serialize)]
pub struct VndbCoverage {
    schema: &'static str,
    fetched_at: String,
    /// VNDB releases with any engine recorded; the share's denominator.
    engine_releases: u64,
    families: Vec<FamilyCoverage>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FamilyCoverage {
    family: String,
    engines: Vec<String>,
    releases: u64,
}

#[derive(Deserialize)]
struct InventoryFamilies {
    cores: Vec<InventoryFamily>,
}

#[derive(Deserialize)]
struct InventoryFamily {
    family_name: String,
}

/// Engine families of `build/cores.toml` in order of first appearance, each
/// with its VNDB engine strings. A family without a mapping fails the build.
fn family_engines(inventory: &str) -> Result<Vec<(String, &'static [&'static str])>> {
    let inventory: InventoryFamilies =
        toml::from_str(inventory).context("parsing build/cores.toml family names")?;
    let mut families: Vec<(String, &'static [&'static str])> = Vec::new();
    for core in inventory.cores {
        if families
            .iter()
            .any(|(family, _)| *family == core.family_name)
        {
            continue;
        }
        let Some((_, engines)) = VNDB_ENGINES
            .iter()
            .find(|(family, _)| *family == core.family_name)
        else {
            bail!(
                "engine family {:?} in build/cores.toml has no VNDB engine strings; add it to VNDB_ENGINES in xtask/src/external.rs",
                core.family_name
            );
        };
        families.push((core.family_name, engines));
    }
    ensure!(
        !families.is_empty(),
        "build/cores.toml lists no engine families"
    );
    Ok(families)
}

fn engine_filter(engines: &[&str]) -> Value {
    let filters: Vec<Value> = engines
        .iter()
        .map(|engine| json!(["engine", "=", engine]))
        .collect();
    if filters.len() == 1 {
        filters.into_iter().next().unwrap()
    } else {
        let mut or = vec![json!("or")];
        or.extend(filters);
        Value::Array(or)
    }
}

#[derive(Deserialize)]
struct VndbCount {
    count: u64,
    results: Vec<Value>,
}

fn vndb_release_count(client: &Client, filters: &Value) -> Result<u64> {
    let response = client
        .post(format!("{VNDB_API}/release"))
        .json(&json!({ "filters": filters, "count": true, "results": 0 }))
        .send()
        .with_context(|| format!("querying VNDB /release count for {filters}"))?
        .error_for_status()
        .with_context(|| format!("VNDB /release count request failed for {filters}"))?;
    let page: VndbCount =
        serde_json::from_slice(&crate::snapshot::read_bounded(response, 64 * 1024)?).with_context(
            || format!("VNDB /release count response for {filters} has an unexpected shape"),
        )?;
    ensure!(
        page.results.is_empty(),
        "VNDB /release returned results for a count-only query ({filters})"
    );
    Ok(page.count)
}

/// VNDB release counts for every engine family in `build/cores.toml`, and the
/// number of VNDB releases with any engine recorded.
pub fn vndb_coverage(client: &Client, inventory: &str) -> Result<VndbCoverage> {
    let engine_releases = vndb_release_count(client, &json!(["engine", "!=", ""]))?;
    let mut families = Vec::new();
    for (family, engines) in family_engines(inventory)? {
        let releases = vndb_release_count(client, &engine_filter(engines))?;
        // A renamed or mistyped engine string matches nothing instead of failing the query.
        ensure!(
            releases > 0,
            "VNDB has no release with engine {engines:?} (family {family:?}); the engine string no longer matches VNDB"
        );
        families.push(FamilyCoverage {
            family,
            engines: engines.iter().map(|engine| (*engine).to_owned()).collect(),
            releases,
        });
    }
    let total: u64 = families.iter().map(|family| family.releases).sum();
    ensure!(
        total <= engine_releases,
        "VNDB family release counts ({total}) exceed releases with an engine ({engine_releases})"
    );
    Ok(VndbCoverage {
        schema: VNDB_COVERAGE_SCHEMA,
        fetched_at: fetch_time()?,
        engine_releases,
        families,
    })
}

fn fetch_time() -> Result<String> {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .context("system clock is before 1970")?
        .as_secs();
    let time = chrono::DateTime::<chrono::Utc>::from_timestamp(
        i64::try_from(seconds).context("system clock out of range")?,
        0,
    )
    .context("system clock out of range")?;
    Ok(time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
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

    #[test]
    fn family_engines_follow_inventory_order_once_per_family() {
        let inventory = r#"
            [[cores]]
            family_name = "Musica"
            [[cores]]
            family_name = "Ren’Py"
            [[cores]]
            family_name = "Musica"
        "#;
        let families = family_engines(inventory).unwrap();
        assert_eq!(
            families,
            [
                ("Musica".to_owned(), &["Musica"][..]),
                ("Ren’Py".to_owned(), &["Ren'Py"][..])
            ]
        );
    }

    #[test]
    fn family_engines_reject_an_unmapped_family() {
        let error = family_engines("[[cores]]\nfamily_name = \"RealLive\"\n").unwrap_err();
        assert!(error.to_string().contains("RealLive"));
    }

    #[test]
    fn engine_filter_ors_several_strings() {
        assert_eq!(engine_filter(&["CMVS"]), json!(["engine", "=", "CMVS"]));
        assert_eq!(
            engine_filter(&["A", "B"]),
            json!(["or", ["engine", "=", "A"], ["engine", "=", "B"]])
        );
    }
}
