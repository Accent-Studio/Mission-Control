//! The endpoint key file and the access rules that keep it private.
//!
//! The key is the PC's identity: whoever reads it can pose as the PC to every paired
//! phone. On Windows its folder and the file itself are limited to the current user
//! (`icacls`), and the result is read back and checked. A new key is only written after
//! the folder and the empty file are locked and checked, so the key bytes never sit in a
//! place that other accounts can read, not even for a moment. An existing key is checked
//! again on every start. If the access rules cannot be set or checked, the bridge does not start.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use iroh::SecretKey;

use crate::logfile::LogFile;

/// Sets and checks "only the current user" access on a file or a folder.
pub trait AclTool: Send + Sync {
    /// Removes inherited entries and grants the current user full access.
    fn restrict(&self, path: &Path, is_dir: bool) -> Result<(), String>;
    /// Reads the access list back. Ok only when the current user is the one and only entry.
    fn verify(&self, path: &Path) -> Result<(), String>;
}

/// How to protect the key. `lock_dir` also locks the folder that holds the key; leave it off for a key file
/// in a folder the bridge does not own.
pub struct Protection<'a> {
    pub tool: &'a dyn AclTool,
    pub lock_dir: bool,
}

fn lock_down(tool: &dyn AclTool, path: &Path, is_dir: bool) -> Result<(), String> {
    tool.restrict(path, is_dir)?;
    tool.verify(path)
}

/// Checks a file that already exists; when the access list is wrong it is set again and checked again.
fn ensure_private(tool: &dyn AclTool, path: &Path, log: &LogFile) -> Result<(), String> {
    if tool.verify(path).is_ok() {
        return Ok(());
    }
    lock_down(tool, path, false)?;
    log.line("the endpoint key file was readable by other accounts; fixed");
    Ok(())
}

/// Reads the endpoint key (32 raw bytes) or makes a new one. A key file of the wrong
/// size is an error and is never replaced: a new identity would unpair every phone.
pub fn load_or_create_key(path: &Path, protect: Option<&Protection<'_>>, log: &LogFile) -> Result<SecretKey, String> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty());
    if let Some(dir) = dir {
        fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        if let Some(p) = protect.filter(|p| p.lock_dir) {
            lock_down(p.tool, dir, true).map_err(|e| format!("the key folder {} could not be limited to the current user: {e}", dir.display()))?;
        }
    }
    let existing = match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => true,
        Ok(bytes) => {
            let arr = <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| format!("{} is not a 32 byte key; move it away to make a new identity", path.display()))?;
            if let Some(p) = protect {
                ensure_private(p.tool, path, log).map_err(|e| format!("the key file {} could not be limited to the current user: {e}", path.display()))?;
            }
            return Ok(SecretKey::from_bytes(&arr));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("cannot read the key file: {e}")),
    };

    // A new key (or an empty file left by a start that stopped half way): lock the empty file first, write after.
    let key = SecretKey::generate();
    let mut opts = OpenOptions::new();
    opts.write(true);
    if existing {
        opts.truncate(true);
    } else {
        opts.create_new(true);
    }
    let mut file = opts.open(path).map_err(|e| format!("cannot create the key file: {e}"))?;
    if let Some(p) = protect {
        if let Err(e) = lock_down(p.tool, path, false) {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(format!("the key file {} could not be limited to the current user: {e}", path.display()));
        }
    }
    if let Err(e) = file.write_all(&key.to_bytes()).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!("cannot write the key file: {e}"));
    }
    log.line("created a new endpoint key");
    Ok(key)
}

/// The access tool of this platform.
pub fn system_acl() -> Box<dyn AclTool> {
    #[cfg(windows)]
    {
        Box::new(Icacls)
    }
    #[cfg(not(windows))]
    {
        Box::new(NoAcl)
    }
}

/// Platforms without `icacls` keep the file's normal mode; there is nothing to set or check.
#[cfg(not(windows))]
pub struct NoAcl;

#[cfg(not(windows))]
impl AclTool for NoAcl {
    fn restrict(&self, _path: &Path, _is_dir: bool) -> Result<(), String> {
        Ok(())
    }
    fn verify(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
pub struct Icacls;

#[cfg(windows)]
fn current_user() -> Result<String, String> {
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let name = std::env::var("USERNAME").unwrap_or_default();
    if domain.is_empty() || name.is_empty() {
        return Err("the current user name is unknown".to_owned());
    }
    Ok(format!("{domain}\\{name}"))
}

#[cfg(windows)]
impl AclTool for Icacls {
    fn restrict(&self, path: &Path, is_dir: bool) -> Result<(), String> {
        let user = current_user()?;
        let path = std::path::absolute(path).map_err(|e| e.to_string())?;
        let rights = if is_dir { "(OI)(CI)F" } else { "F" };
        // An argument list, never a shell string.
        let out = std::process::Command::new("icacls")
            .arg(&path)
            .args(["/inheritance:r", "/grant:r"])
            .arg(format!("{user}:{rights}"))
            .output()
            .map_err(|e| format!("icacls did not start: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("icacls failed ({})", out.status))
        }
    }

    fn verify(&self, path: &Path) -> Result<(), String> {
        let user = current_user()?;
        let path = std::path::absolute(path).map_err(|e| e.to_string())?;
        let out = std::process::Command::new("icacls").arg(&path).output().map_err(|e| format!("icacls did not start: {e}"))?;
        if !out.status.success() {
            return Err(format!("icacls could not read the access list ({})", out.status));
        }
        if only_user(&String::from_utf8_lossy(&out.stdout), &path.to_string_lossy(), &user) {
            Ok(())
        } else {
            Err("the access list holds more than the current user, or could not be understood".to_owned())
        }
    }
}

/// True when every entry in `icacls` output belongs to `user` and there is at least one.
/// Entries look like `<path> DOMAIN\user:(F)` on the first line and `   DOMAIN\other:(F)` on the rest.
/// Anything that cannot be read as an entry counts against it, so the check fails closed.
#[cfg_attr(not(windows), allow(dead_code))]
fn only_user(output: &str, path: &str, user: &str) -> bool {
    let (path, user) = (path.to_lowercase(), user.to_lowercase());
    let mut entries = 0;
    for line in output.lines() {
        let Some(at) = line.find(":(") else { continue };
        let name = line[..at].to_lowercase();
        let name = name.strip_prefix(&path).unwrap_or(&name);
        if name.trim() != user {
            return false;
        }
        entries += 1;
    }
    entries > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records what is asked of it. `widened` stands for an extra account on the list.
    #[derive(Default)]
    struct FakeAcl {
        calls: Mutex<Vec<String>>,
        /// File length seen at each restrict call (proves the key bytes come last).
        sizes: Mutex<Vec<u64>>,
        fail_restrict: bool,
        restrict_does_not_help: bool,
        widened: std::sync::atomic::AtomicBool,
    }

    impl AclTool for FakeAcl {
        fn restrict(&self, path: &Path, is_dir: bool) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("restrict {}", if is_dir { "dir" } else { "file" }));
            if !is_dir {
                self.sizes.lock().unwrap().push(fs::metadata(path).map_or(u64::MAX, |m| m.len()));
            }
            if self.fail_restrict {
                return Err("simulated icacls failure".to_owned());
            }
            if !self.restrict_does_not_help {
                self.widened.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(())
        }
        fn verify(&self, path: &Path) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("verify {}", if path.is_dir() { "dir" } else { "file" }));
            if self.widened.load(std::sync::atomic::Ordering::SeqCst) {
                Err("another account is on the list".to_owned())
            } else {
                Ok(())
            }
        }
    }

    struct Tmp(std::path::PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!("mcb-key-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_new_key_is_written_only_after_folder_and_file_are_locked_and_checked() {
        let tmp = Tmp::new("new");
        let path = tmp.0.join("bridge").join("endpoint.key");
        let acl = FakeAcl::default();
        let log = LogFile::memory();
        let key = load_or_create_key(&path, Some(&Protection { tool: &acl, lock_dir: true }), &log).unwrap();
        assert_eq!(acl.calls.lock().unwrap().clone(), ["restrict dir", "verify dir", "restrict file", "verify file"]);
        assert_eq!(acl.sizes.lock().unwrap().clone(), [0], "the key bytes were already in the file when it was locked");
        assert_eq!(fs::read(&path).unwrap(), key.to_bytes());
        // The next start reads the same key and checks the access list again.
        let again = load_or_create_key(&path, Some(&Protection { tool: &acl, lock_dir: true }), &log).unwrap();
        assert_eq!(again.to_bytes(), key.to_bytes());
    }

    #[test]
    fn no_key_is_written_when_the_access_list_cannot_be_set() {
        let tmp = Tmp::new("failrestrict");
        let path = tmp.0.join("endpoint.key");
        let acl = FakeAcl { fail_restrict: true, ..FakeAcl::default() };
        let err = load_or_create_key(&path, Some(&Protection { tool: &acl, lock_dir: true }), &LogFile::memory()).unwrap_err();
        assert!(err.contains("folder"), "{err}");
        assert!(!path.exists());

        // Folder fine (not asked for), file cannot be locked: the new file is removed again.
        let err = load_or_create_key(&path, Some(&Protection { tool: &acl, lock_dir: false }), &LogFile::memory()).unwrap_err();
        assert!(err.contains("key file"), "{err}");
        assert!(!path.exists(), "a key file was left behind");
    }

    #[test]
    fn no_key_is_written_when_the_check_fails() {
        let tmp = Tmp::new("failverify");
        let path = tmp.0.join("endpoint.key");
        let acl = FakeAcl { restrict_does_not_help: true, ..FakeAcl::default() };
        acl.widened.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(load_or_create_key(&path, Some(&Protection { tool: &acl, lock_dir: true }), &LogFile::memory()).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn an_existing_key_with_a_wide_access_list_is_fixed_or_refused() {
        let tmp = Tmp::new("existing");
        fs::create_dir_all(&tmp.0).unwrap();
        let path = tmp.0.join("endpoint.key");
        let bytes = [7u8; 32];
        fs::write(&path, bytes).unwrap();

        let acl = FakeAcl::default();
        acl.widened.store(true, std::sync::atomic::Ordering::SeqCst);
        let log = LogFile::memory();
        let key = load_or_create_key(&path, Some(&Protection { tool: &acl, lock_dir: false }), &log).unwrap();
        assert_eq!(key.to_bytes(), bytes);
        assert!(acl.calls.lock().unwrap().iter().any(|c| c == "restrict file"));
        assert!(log.lines().iter().any(|l| l.contains("fixed")));

        let stubborn = FakeAcl { restrict_does_not_help: true, ..FakeAcl::default() };
        stubborn.widened.store(true, std::sync::atomic::Ordering::SeqCst);
        let err = load_or_create_key(&path, Some(&Protection { tool: &stubborn, lock_dir: false }), &LogFile::memory()).unwrap_err();
        assert!(err.contains("could not be limited"), "{err}");
        assert_eq!(fs::read(&path).unwrap(), bytes, "the key must survive a refusal");
    }

    #[test]
    fn a_key_of_the_wrong_size_is_never_replaced_but_an_empty_leftover_is_filled() {
        let tmp = Tmp::new("sizes");
        fs::create_dir_all(&tmp.0).unwrap();
        let path = tmp.0.join("endpoint.key");
        fs::write(&path, [1u8; 31]).unwrap();
        assert!(load_or_create_key(&path, None, &LogFile::memory()).is_err());
        assert_eq!(fs::read(&path).unwrap(), [1u8; 31]);

        fs::write(&path, b"").unwrap();
        let acl = FakeAcl::default();
        let key = load_or_create_key(&path, Some(&Protection { tool: &acl, lock_dir: false }), &LogFile::memory()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), key.to_bytes());
    }

    #[test]
    fn icacls_output_is_read_strictly() {
        let path = r"D:\data\bridge\endpoint.key";
        let user = r"DESKTOP-1\alex";
        let ok = "D:\\data\\bridge\\endpoint.key DESKTOP-1\\alex:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n";
        assert!(only_user(ok, path, user));
        let two = "D:\\data\\bridge\\endpoint.key DESKTOP-1\\alex:(F)\n                               NT AUTHORITY\\SYSTEM:(F)\n\nSuccessfully processed 1 files\n";
        assert!(!only_user(two, path, user));
        let dir = "D:\\data\\bridge DESKTOP-1\\alex:(OI)(CI)(F)\n\nSuccessfully processed 1 files\n";
        assert!(only_user(dir, r"D:\data\bridge", user));
        assert!(only_user(&ok.to_uppercase(), path, user), "names compare without case");
        assert!(!only_user("Successfully processed 1 files\n", path, user), "no entry at all is not private");
        assert!(!only_user("D:\\data\\bridge\\endpoint.key OTHER\\alex:(F)\n", path, user));
        // A path that icacls printed differently than it was given cannot be matched: refused, not guessed.
        assert!(!only_user(ok, r"D:\elsewhere\endpoint.key", user));
    }

    /// The real tool, on a scratch folder: after the call only the current user is on the lists.
    #[cfg(windows)]
    #[test]
    fn the_real_icacls_locks_a_new_key_to_the_current_user() {
        let tmp = Tmp::new("real");
        let path = tmp.0.join("bridge").join("endpoint.key");
        let tool = Icacls;
        let log = LogFile::memory();
        load_or_create_key(&path, Some(&Protection { tool: &tool, lock_dir: true }), &log).unwrap();
        tool.verify(path.parent().unwrap()).unwrap();
        tool.verify(&path).unwrap();
        // Loading it again passes the check without changes.
        load_or_create_key(&path, Some(&Protection { tool: &tool, lock_dir: true }), &log).unwrap();
        assert!(!log.lines().iter().any(|l| l.contains("fixed")));
    }
}
