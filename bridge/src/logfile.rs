//! A small size-rotated log file (`bridge.log`, then `bridge.log.1` to `.N`).
//!
//! Every line is one event: a UTC time stamp, then the text. Control characters in
//! the text are replaced so nothing a peer sends (a device name, a path) can fake
//! a second log line. The callers decide what may be logged; this file never gets
//! query strings, headers, bodies, the bridge secret or pairing codes.
//!
//! The console copy of each line is written by one dedicated thread that is fed
//! through a bounded queue. A console can stall (a selection in the Windows console
//! pauses every write to it), and a stalled console must never stop a worker of the
//! async runtime: when the queue is full the console line is dropped (the file keeps it).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Console lines that may wait for the console thread before new ones are dropped.
const ECHO_QUEUE: usize = 512;

enum Sink {
    /// Rotating file on disk.
    File { dir: PathBuf, name: String, file: File, size: u64, max: u64, keep: usize },
    /// Console only.
    None,
    /// Kept in memory (tests).
    Memory(Vec<String>),
}

/// The queue to the console thread. The thread ends when this is dropped.
struct Echo {
    tx: SyncSender<String>,
    dropped: Arc<AtomicU64>,
}

impl Echo {
    fn start(mut out: Box<dyn Write + Send>, capacity: usize) -> Echo {
        let (tx, rx) = sync_channel::<String>(capacity);
        let dropped = Arc::new(AtomicU64::new(0));
        let missed = dropped.clone();
        // If the thread cannot start, the queue has no reader and every console line is counted as dropped.
        let _ = std::thread::Builder::new().name("log-echo".to_owned()).spawn(move || {
            for line in rx {
                let n = missed.swap(0, Ordering::Relaxed);
                if n > 0 {
                    let _ = writeln!(out, "{} {n} console lines were skipped (the console was slow)", utc_stamp());
                }
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
        });
        Echo { tx, dropped }
    }

    fn offer(&self, line: &str) {
        if self.tx.try_send(line.to_owned()).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub struct LogFile {
    sink: Mutex<Sink>,
    echo: Option<Echo>,
}

impl LogFile {
    /// Opens (or creates) `dir/name` for appending. `echo` also prints every line to stdout.
    pub fn open(dir: &Path, name: &str, max_bytes: u64, keep: usize, echo: bool) -> io::Result<LogFile> {
        let out: Option<Box<dyn Write + Send>> = echo.then(|| Box::new(io::stdout()) as Box<dyn Write + Send>);
        LogFile::open_with_echo(dir, name, max_bytes, keep, out)
    }

    /// Like `open`, with the console copy going to `out` (tests pass a writer of their own).
    pub fn open_with_echo(dir: &Path, name: &str, max_bytes: u64, keep: usize, out: Option<Box<dyn Write + Send>>) -> io::Result<LogFile> {
        fs::create_dir_all(dir)?;
        let path = dir.join(name);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata()?.len();
        let echo = out.map(|o| Echo::start(o, ECHO_QUEUE));
        Ok(LogFile { sink: Mutex::new(Sink::File { dir: dir.to_owned(), name: name.to_owned(), file, size, max: max_bytes, keep }), echo })
    }

    /// Console only.
    pub fn console() -> LogFile {
        LogFile { sink: Mutex::new(Sink::None), echo: Some(Echo::start(Box::new(io::stdout()), ECHO_QUEUE)) }
    }

    /// Keeps lines in memory and prints nothing.
    pub fn memory() -> LogFile {
        LogFile { sink: Mutex::new(Sink::Memory(Vec::new())), echo: None }
    }

    /// The lines written so far (memory sink only).
    pub fn lines(&self) -> Vec<String> {
        match &*self.sink.lock().unwrap_or_else(|e| e.into_inner()) {
            Sink::Memory(v) => v.clone(),
            _ => Vec::new(),
        }
    }

    pub fn line(&self, text: &str) {
        let line = format!("{} {}", utc_stamp(), clean(text));
        if let Some(echo) = &self.echo {
            echo.offer(&line);
        }
        let mut sink = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *sink {
            Sink::None => {}
            Sink::Memory(v) => v.push(line),
            Sink::File { dir, name, file, size, max, keep } => {
                let bytes = line.len() as u64 + 1;
                if *size > 0 && *size + bytes > *max {
                    if let Ok(f) = rotate(dir, name, *keep) {
                        *file = f;
                        *size = 0;
                    }
                }
                if writeln!(file, "{line}").is_ok() {
                    *size += bytes;
                }
            }
        }
    }
}

/// Moves `name` to `name.1`, `name.1` to `name.2` and so on, dropping the oldest, and opens a fresh file.
fn rotate(dir: &Path, name: &str, keep: usize) -> io::Result<File> {
    let numbered = |n: usize| dir.join(format!("{name}.{n}"));
    if keep > 0 {
        let _ = fs::remove_file(numbered(keep));
        for n in (1..keep).rev() {
            let _ = fs::rename(numbered(n), numbered(n + 1));
        }
        let _ = fs::rename(dir.join(name), numbered(1));
    }
    OpenOptions::new().create(true).write(true).truncate(true).open(dir.join(name))
}

/// Control characters become spaces so a value cannot start a new line.
fn clean(text: &str) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// `2026-10-12T08:30:15Z`, from the system clock, without a date library.
pub fn utc_stamp() -> String {
    iso_utc(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()))
}

pub fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_791_793_815), "2026-10-12T08:30:15Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn control_characters_cannot_split_a_line() {
        let log = LogFile::memory();
        log.line("device Evil\r\n2026-01-01T00:00:00Z fake line");
        let lines = log.lines();
        assert_eq!(lines.len(), 1);
        assert!(!lines[0].contains('\n') && !lines[0].contains('\r'));
    }

    /// A console that accepts nothing until it is released.
    struct StuckConsole {
        released: Arc<std::sync::atomic::AtomicBool>,
        written: Arc<Mutex<Vec<String>>>,
    }

    impl Write for StuckConsole {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            while !self.released.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            self.written.lock().unwrap().push(String::from_utf8_lossy(buf).into_owned());
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_stuck_console_never_stops_the_caller_and_the_file_keeps_every_line() {
        let dir = std::env::temp_dir().join(format!("mcb-log-stuck-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let written = Arc::new(Mutex::new(Vec::new()));
        let console = StuckConsole { released: released.clone(), written: written.clone() };
        let log = LogFile::open_with_echo(&dir, "t.log", 10 * 1024 * 1024, 1, Some(Box::new(console))).unwrap();
        let t = std::time::Instant::now();
        for i in 0..5000 {
            log.line(&format!("line {i}"));
        }
        assert!(t.elapsed() < std::time::Duration::from_secs(5), "logging waited for the console: {:?}", t.elapsed());
        let on_disk = fs::read_to_string(dir.join("t.log")).unwrap();
        assert_eq!(on_disk.lines().count(), 5000);
        // Once the console wakes up it gets what fitted in the queue, and a note about the rest.
        released.store(true, Ordering::SeqCst);
        let mut last = 0;
        for _ in 0..100 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let n = written.lock().unwrap().len();
            if n > 0 && n == last {
                break;
            }
            last = n;
        }
        let text = written.lock().unwrap().join("");
        assert!(text.contains("console lines were skipped"), "no note about the skipped lines");
        let echoed = text.matches("Z line ").count();
        assert!(echoed < 5000 && echoed > 0, "the console got {echoed} of 5000 lines");
        drop(log);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_and_keeps_a_fixed_number() {
        let dir = std::env::temp_dir().join(format!("mcb-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let log = LogFile::open(&dir, "t.log", 200, 2, false).unwrap();
        for i in 0..40 {
            log.line(&format!("line number {i} with some padding to fill the file"));
        }
        assert!(dir.join("t.log").exists() && dir.join("t.log.1").exists() && dir.join("t.log.2").exists());
        assert!(!dir.join("t.log.3").exists());
        assert!(fs::metadata(dir.join("t.log")).unwrap().len() <= 260);
        let _ = fs::remove_dir_all(&dir);
    }
}
