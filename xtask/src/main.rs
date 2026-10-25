mod external;
mod site;
mod snapshot;
mod versions;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Build and deploy the Project-Shinkirou portal")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Site {
        #[command(subcommand)]
        command: SiteCommand,
    },
}

#[derive(Subcommand)]
enum SiteCommand {
    /// Resolve both public product main revisions through the GitHub API.
    Sources {
        #[arg(long)]
        out: PathBuf,
    },
    /// Generate metadata and bind documentation to exact checkout revisions.
    Prepare {
        #[arg(long)]
        roukaku: PathBuf,
        #[arg(long)]
        shinkiemu: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// Build production inputs, or synthetic fixtures when --prepared is omitted.
    Build {
        #[arg(long)]
        prepared: Option<PathBuf>,
    },
    /// Serve prepared inputs, or synthetic fixtures when --prepared is omitted.
    Dev {
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        #[arg(long, default_value_t = 4321)]
        port: u16,
        #[arg(long)]
        prepared: Option<PathBuf>,
    },
    /// Download the deployed index and verify every indexed file.
    Verify {
        #[arg(long)]
        base_url: String,
    },
}

fn main() -> Result<()> {
    let Command::Site { command } = Cli::parse().command;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    match command {
        SiteCommand::Sources { out } => site::sources(&out),
        SiteCommand::Prepare {
            roukaku,
            shinkiemu,
            out,
        } => site::prepare(&roukaku, &shinkiemu, &out),
        SiteCommand::Build { prepared } => site::npm(&root, prepared.as_deref(), None),
        SiteCommand::Dev {
            host,
            port,
            prepared,
        } => site::npm(&root, prepared.as_deref(), Some((&host, port))),
        SiteCommand::Verify { base_url } => snapshot::verify(&base_url),
    }
}
