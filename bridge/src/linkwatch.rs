//! Logs what happens to one connection while it lives, on the PC and on the phone alike: which network path
//! carries it (relay or direct) and when that changes, every stretch of silence from the other side, and a summary
//! when it closes. A link that stalls then shows where it went quiet and over which path.

use std::sync::Arc;
use std::time::{Duration, Instant};

use iroh::endpoint::{Connection, PathEvent};
use iroh::TransportAddr;
use n0_future::StreamExt;

/// One line of the log (no timestamp: the caller's log adds it).
pub type LineFn = Arc<dyn Fn(String) + Send + Sync>;

/// How often the silence check looks at the receive counter.
const SAMPLE: Duration = Duration::from_secs(1);
/// Silence from the other side worth a line. Keep-alives arrive every few seconds, so anything longer is a stall.
const QUIET: Duration = Duration::from_secs(4);

/// A short name for a connection, the same on every line about it.
pub fn conn_tag(conn: &Connection) -> String {
    format!("c{:x}", conn.stable_id() & 0xffff)
}

fn addr_text(a: &TransportAddr) -> String {
    match a {
        TransportAddr::Ip(ip) => format!("direct {ip}"),
        TransportAddr::Relay(url) => format!("relay {}", url.as_str().trim_end_matches('/')),
        other => format!("{other:?}"),
    }
}

/// Starts watching `conn`. `who` names the other side in each line (for example `dev=cbc70ad5`).
pub fn watch(conn: Connection, who: String, log: LineFn) {
    let tag = conn_tag(&conn);
    let born = Instant::now();

    // Path changes.
    {
        let (tag, who, log) = (tag.clone(), who.clone(), log.clone());
        let mut events = conn.path_events();
        tokio::spawn(async move {
            while let Some(ev) = events.next().await {
                let at = born.elapsed().as_secs_f32();
                let line = match ev {
                    PathEvent::Opened { id, remote_addr, .. } => format!("path opened {who} {tag} p{id:?} {} t={at:.1}s", addr_text(&remote_addr)),
                    PathEvent::Selected { id, remote_addr, .. } => format!("path selected {who} {tag} p{id:?} {} t={at:.1}s", addr_text(&remote_addr)),
                    PathEvent::Closed { id, remote_addr, last_stats, .. } => format!(
                        "path closed {who} {tag} p{id:?} {} t={at:.1}s rtt={}ms sent={} recv={} lost={} blackholes={}",
                        addr_text(&remote_addr),
                        last_stats.rtt.as_millis(),
                        last_stats.udp_tx.datagrams,
                        last_stats.udp_rx.datagrams,
                        last_stats.lost_packets,
                        last_stats.black_holes_detected
                    ),
                    PathEvent::Lagged { missed, .. } => format!("path events missed {who} {tag} n={missed}"),
                    other => format!("path event {who} {tag} {other:?}"),
                };
                log(line);
            }
        });
    }

    // Silence from the other side, and the summary at the end.
    tokio::spawn(async move {
        let mut last_rx = conn.stats().udp_rx.datagrams;
        let mut heard = Instant::now();
        let mut quiet_said = false;
        loop {
            tokio::select! {
                _ = conn.closed() => break,
                _ = tokio::time::sleep(SAMPLE) => {}
            }
            let rx = conn.stats().udp_rx.datagrams;
            if rx != last_rx {
                if quiet_said {
                    log(format!("heard again {who} {tag} after {:.1}s silence t={:.1}s", heard.elapsed().as_secs_f32(), born.elapsed().as_secs_f32()));
                    quiet_said = false;
                }
                last_rx = rx;
                heard = Instant::now();
            } else if !quiet_said && heard.elapsed() >= QUIET {
                let path = conn.paths().iter().find(|p| p.is_selected()).map(|p| addr_text(p.remote_addr())).unwrap_or_else(|| "no path".to_owned());
                log(format!("quiet {who} {tag} nothing received for {:.1}s on {path} t={:.1}s", heard.elapsed().as_secs_f32(), born.elapsed().as_secs_f32()));
                quiet_said = true;
            }
        }
        let s = conn.stats();
        log(format!(
            "link summary {who} {tag} lived={:.1}s last_heard={:.1}s_ago sent={} recv={} lost={}",
            born.elapsed().as_secs_f32(),
            heard.elapsed().as_secs_f32(),
            s.udp_tx.datagrams,
            s.udp_rx.datagrams,
            s.lost_packets
        ));
    });
}
