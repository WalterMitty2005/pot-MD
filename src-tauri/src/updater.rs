use crate::config::{get, set};
use crate::window::updater_window;
use log::{info, warn};
use serde::Deserialize;

// pot-MD ships from its own repository, so this is the only place that can tell
// us about new pot-MD builds. The Tauri built-in updater that used to live here
// could not: its endpoint served upstream pot-app/pot-desktop's release manifest,
// which is signed with upstream's private key. Now that the version line was
// reset to 1.0.0, that endpoint would also have reported upstream 3.0.7 as
// "newer" on every launch and popped the updater window forever.
const RELEASES_API: &str = "https://api.github.com/repos/WalterMitty2005/pot-MD/releases";

#[derive(Deserialize)]
struct Release {
    tag_name: Option<String>,
    name: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

// Numeric components of a tag, so 1.0.10 > 1.0.9. Non-numeric chunks (the "MD"
// in "3.0.7-MD.8") are dropped rather than making the whole tag unparsable.
fn version_parts(v: &str) -> Vec<u64> {
    v.trim_start_matches(['v', 'V'])
        .split(['.', '-', '+', '_'])
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|s| s.parse::<u64>().ok())
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let a = version_parts(latest);
    let b = version_parts(current);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    // Identical numeric core: fall back to a case-insensitive string compare so
    // a suffix-only bump still registers as an update.
    let norm = |s: &str| s.trim_start_matches(['v', 'V']).to_lowercase();
    norm(latest) != norm(current)
}

async fn latest_remote_version() -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(RELEASES_API)
        .header(reqwest::header::USER_AGENT, "pot-MD")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GitHub API {}", res.status()));
    }
    let list: Vec<Release> = res.json().await.map_err(|e| e.to_string())?;
    // Prefer the newest full release; earlier pot-MD builds were published as
    // pre-releases, so fall back to those rather than reporting "no releases".
    let picked = list
        .iter()
        .find(|r| !r.draft && !r.prerelease)
        .or_else(|| list.iter().find(|r| !r.draft));
    Ok(picked
        .and_then(|r| r.tag_name.clone().or_else(|| r.name.clone()))
        .filter(|s| !s.is_empty()))
}

pub fn check_update(app_handle: tauri::AppHandle) {
    let enable = match get("check_update") {
        Some(v) => v.as_bool().unwrap_or(true),
        None => {
            set("check_update", true);
            true
        }
    };
    if !enable {
        return;
    }
    tauri::async_runtime::spawn(async move {
        match latest_remote_version().await {
            Ok(Some(tag)) => {
                let current = app_handle.package_info().version.to_string();
                if is_newer(&tag, &current) {
                    info!("New version available: {} (current {})", tag, current);
                    updater_window();
                } else {
                    info!("Already up to date: {} (latest {})", current, tag);
                }
            }
            Ok(None) => warn!("No release found in the pot-MD repository"),
            Err(e) => warn!("Failed to check update: {}", e),
        }
    });
}
