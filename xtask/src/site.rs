use anyhow::{Context, Result, ensure};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

pub fn http_client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent("Project-Shinkirou-portal-xtask")
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

#[derive(Serialize)]
struct Sources {
    roukaku_commit: String,
    shinkiemu_commit: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepared {
    roukaku_docs_dir: PathBuf,
    shinkiemu_docs_dir: PathBuf,
}

#[derive(Serialize)]
struct SiteSources {
    #[serde(flatten)]
    commits: Sources,
    generated_at: String,
}

pub fn sources(out: &Path) -> Result<()> {
    let client = http_client()?;
    let token = std::env::var("GITHUB_TOKEN").ok().filter(|s| !s.is_empty());
    let resolve = |repo: &str| -> Result<String> {
        let url = format!("https://api.github.com/repos/Project-Shinkirou/{repo}/git/ref/heads/main");
        let mut request = client.get(url).header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        }
        #[derive(Deserialize)]
        struct GitRef { object: GitObject }
        #[derive(Deserialize)]
        struct GitObject {
            sha: String,
            #[serde(rename = "type")]
            kind: String,
        }
        let bytes = crate::snapshot::read_bounded(request.send()?.error_for_status()?, 1024 * 1024)?;
        let reference: GitRef = serde_json::from_slice(&bytes)?;
        ensure!(reference.object.kind == "commit" && crate::snapshot::is_commit(&reference.object.sha),
            "invalid GitHub commit for {repo}");
        Ok(reference.object.sha)
    };
    write_json(out, &Sources {
        roukaku_commit: resolve("RoukakuEngine")?,
        shinkiemu_commit: resolve("ShinkiEMU")?,
    })
}

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let result = Command::new("git").arg("-C").arg(dir).args(args).output()
        .with_context(|| format!("running git in {}", dir.display()))?;
    ensure!(result.status.success(), "git failed in {}: {}", dir.display(), String::from_utf8_lossy(&result.stderr));
    Ok(String::from_utf8(result.stdout)?.trim().into())
}

fn revision(dir: &Path) -> Result<(String, i64)> {
    let commit = git(dir, &["rev-parse", "HEAD"])?;
    ensure!(crate::snapshot::is_commit(&commit), "invalid checkout revision");
    let timestamp = git(dir, &["show", "-s", "--format=%ct", "HEAD"])?.parse()?;
    Ok((commit, timestamp))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create(path)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn new_directory(out: &Path) -> Result<PathBuf> {
    if let Some(parent) = out.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(out).with_context(|| format!("output directory must be new: {}", out.display()))?;
    Ok(dunce::canonicalize(out)?)
}

pub fn prepare(roukaku: &Path, shinkiemu: &Path, out: &Path) -> Result<()> {
    // Claim the destination before starting any subprocess; never touch existing output.
    let out = new_directory(out)?;
    let result = (|| -> Result<()> {
        let roukaku = dunce::canonicalize(roukaku).context("opening RoukakuEngine checkout")?;
        let shinkiemu = dunce::canonicalize(shinkiemu).context("opening ShinkiEMU checkout")?;
        let (roukaku_commit, roukaku_time) = revision(&roukaku)?;
        let (shinkiemu_commit, shinkiemu_time) = revision(&shinkiemu)?;
        let prepared = Prepared {
            roukaku_docs_dir: dunce::canonicalize(roukaku.join("docs"))?,
            shinkiemu_docs_dir: dunce::canonicalize(shinkiemu.join("docs"))?,
        };
        ensure!(prepared.roukaku_docs_dir.is_dir() && prepared.shinkiemu_docs_dir.is_dir(), "product docs must be directories");
        let generated_at = DateTime::<Utc>::from_timestamp(roukaku_time.max(shinkiemu_time), 0)
            .context("invalid source commit time")?.to_rfc3339_opts(SecondsFormat::Secs, true);
        let data = out.join("data");
        let metadata_target = std::env::var_os("CARGO_TARGET_DIR")
            .map(|dir| PathBuf::from(dir).join("metadata"))
            .unwrap_or_else(|| shinkiemu.join(".work/target/site-metadata"));
        run(Command::new("cargo").current_dir(&shinkiemu)
            .args(["xtask", "metadata", "build", "--out"]).arg(&data)
            // The product checkout's xtask alias runs Cargo with --locked.
            .env("CARGO_TARGET_DIR", metadata_target), "ShinkiEMU metadata build")?;
        for (source, destination) in [("cores.toml", "build-cores.toml"), ("targets.toml", "build-targets.toml")] {
            fs::copy(shinkiemu.join("build").join(source), data.join(destination))?;
        }
        write_json(&data.join("site-sources.json"), &SiteSources {
            commits: Sources { roukaku_commit: roukaku_commit.clone(), shinkiemu_commit: shinkiemu_commit.clone() },
            generated_at,
        })?;
        ensure!(revision(&roukaku)?.0 == roukaku_commit && revision(&shinkiemu)?.0 == shinkiemu_commit,
            "checkout revisions changed during preparation");
        write_json(&out.join("prepared.json"), &prepared)?;
        println!("Prepared site inputs: {}", out.display());
        Ok(())
    })();
    if result.is_err() {
        fs::remove_dir_all(&out).with_context(|| format!("cleaning failed preparation {}", out.display()))?;
    }
    result
}

fn run(command: &mut Command, label: &str) -> Result<()> {
    let status = command.status().with_context(|| format!("starting {label}"))?;
    ensure!(status.success(), "{label} failed with {status}");
    Ok(())
}

pub fn npm(root: &Path, prepared: Option<&Path>, dev: Option<(&str, u16)>) -> Result<()> {
    let inputs = prepared.map(|dir| -> Result<(PathBuf, Prepared)> {
        let dir = dunce::canonicalize(dir).context("opening prepared inputs")?;
        let mut inputs: Prepared = serde_json::from_slice(&fs::read(dir.join("prepared.json"))?)?;
        // Node's path resolution needs ordinary Windows paths, not verbatim prefixes.
        inputs.roukaku_docs_dir = dunce::canonicalize(&inputs.roukaku_docs_dir)?;
        inputs.shinkiemu_docs_dir = dunce::canonicalize(&inputs.shinkiemu_docs_dir)?;
        ensure!(dir.join("data/index.json").is_file(), "prepared snapshot is missing index.json");
        Ok((dir, inputs))
    }).transpose()?;
    let executable = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let configure = || {
        let mut cmd = Command::new(executable);
        cmd.current_dir(root);
        for key in ["SITE_PRODUCTION", "SHINKI_DATA_DIR", "ROUKAKU_DOCS_DIR", "SHINKIEMU_DOCS_DIR"] {
            cmd.env_remove(key);
        }
        if let Some((dir, inputs)) = &inputs {
            cmd.env("SITE_PRODUCTION", "1")
                .env("SHINKI_DATA_DIR", dir.join("data"))
                .env("ROUKAKU_DOCS_DIR", &inputs.roukaku_docs_dir)
                .env("SHINKIEMU_DOCS_DIR", &inputs.shinkiemu_docs_dir);
        }
        cmd
    };
    run(configure().arg("ci"), "npm ci")?;
    let mut command = configure();
    if let Some((host, port)) = dev {
        ensure!(port != 0, "dev port must be nonzero");
        command.args(["run", "dev", "--", "--host", host, "--port", &port.to_string()]);
    } else {
        command.args(["run", "build"]);
    }
    run(&mut command, if dev.is_some() { "site dev server" } else { "site build" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_preserves_existing_output_before_running_tools() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("existing");
        fs::create_dir(&out).unwrap();
        fs::write(out.join("keep"), b"original").unwrap();
        assert!(prepare(Path::new("missing-roukaku"), Path::new("missing-shinkiemu"), &out).is_err());
        assert_eq!(fs::read(out.join("keep")).unwrap(), b"original");
        assert_eq!(fs::read_dir(out).unwrap().count(), 1);
    }

    #[test]
    fn failed_prepare_removes_only_its_new_output() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("new");
        assert!(prepare(&temp.path().join("missing"), temp.path(), &out).is_err());
        assert!(!out.exists());
        assert!(temp.path().exists());
    }
}
