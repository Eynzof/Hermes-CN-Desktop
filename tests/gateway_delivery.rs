//! Integration tests for the SQLite-backed gateway delivery ledger.
//!
//! Uses `tempfile::TempDir` for the DB root (never `/tmp` or cwd) per AGENTS.md.
//! Exercises the `pub` API of `hermes_agent_cn::gateway::delivery`.

use hermes_agent_cn::gateway::delivery::{DeliveryLedger, DeliveryState, OutboundPayload};
use pretty_assertions::assert_eq;

const SESSION: &str = "sess_1";
const PLATFORM: &str = "telegram";
const CHAT: &str = "c1";

fn text_payload(text: &str) -> OutboundPayload {
    OutboundPayload {
        text: text.to_string(),
        media_path: None,
        explicit_media: None,
    }
}

#[test]
fn sqlite_begin_and_list_for_session() {
    let home = tempfile::tempdir().expect("tempdir");
    let mut ledger = DeliveryLedger::sqlite(home.path().to_str().unwrap()).unwrap();
    let row = ledger
        .begin(SESSION, PLATFORM, CHAT, &text_payload("hi"))
        .unwrap();
    assert_eq!(row.state, DeliveryState::Pending);
    assert_eq!(row.attempts, 0);
    assert!(row.row_id.starts_with("dl_"));

    let rows = ledger.list_for_session(SESSION).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].row_id, row.row_id);
    assert_eq!(rows[0].session_id, SESSION);
    assert_eq!(rows[0].platform, PLATFORM);
    assert_eq!(rows[0].chat_id, CHAT);
    // Only the requested session is listed.
    let other = ledger
        .begin("other", PLATFORM, CHAT, &text_payload("x"))
        .unwrap();
    assert_eq!(ledger.list_for_session(SESSION).unwrap().len(), 1);
    let _ = other;
}

#[test]
fn sqlite_persists_across_reopen() {
    let home = tempfile::tempdir().expect("tempdir");
    let path = home.path().to_str().unwrap();
    let row = {
        let mut ledger = DeliveryLedger::sqlite(path).unwrap();
        ledger
            .begin(SESSION, PLATFORM, CHAT, &text_payload("durable"))
            .unwrap()
    };

    let ledger = DeliveryLedger::sqlite(path).unwrap();
    let rows = ledger.list_for_session(SESSION).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].row_id, row.row_id);
    assert_eq!(rows[0].payload, row.payload);
}

#[test]
fn sqlite_ack_marks_delivered() {
    let home = tempfile::tempdir().expect("tempdir");
    let mut ledger = DeliveryLedger::sqlite(home.path().to_str().unwrap()).unwrap();
    let row = ledger
        .begin(SESSION, PLATFORM, CHAT, &text_payload("hi"))
        .unwrap();
    ledger.ack(&row.row_id).unwrap();
    assert_eq!(
        ledger.list_for_session(SESSION).unwrap()[0].state,
        DeliveryState::Delivered
    );
}

#[test]
fn sqlite_fail_increments_and_fails_after_max() {
    let home = tempfile::tempdir().expect("tempdir");
    let mut ledger = DeliveryLedger::sqlite(home.path().to_str().unwrap()).unwrap();
    let row = ledger
        .begin(SESSION, PLATFORM, CHAT, &text_payload("hi"))
        .unwrap();

    ledger.fail(&row.row_id, Some("boom")).unwrap();
    ledger.fail(&row.row_id, None).unwrap();
    assert_eq!(ledger.list_for_session(SESSION).unwrap()[0].attempts, 2);
    assert_eq!(
        ledger.list_for_session(SESSION).unwrap()[0].state,
        DeliveryState::Pending
    );

    ledger.fail(&row.row_id, None).unwrap();
    assert_eq!(
        ledger.list_for_session(SESSION).unwrap()[0].state,
        DeliveryState::Failed
    );
    assert_eq!(ledger.list_for_session(SESSION).unwrap()[0].attempts, 3);
}

#[test]
fn sqlite_redeliver_on_boot_recovers_pending_with_prefix() {
    let home = tempfile::tempdir().expect("tempdir");
    let mut ledger = DeliveryLedger::sqlite(home.path().to_str().unwrap()).unwrap();
    let pending = ledger
        .begin(SESSION, PLATFORM, CHAT, &text_payload("lost"))
        .unwrap();

    let stale = ledger.redeliver_on_boot().unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].row_id, pending.row_id);
    assert_eq!(stale[0].state, DeliveryState::Pending);
    let parsed: OutboundPayload = serde_json::from_str(&stale[0].payload).unwrap();
    assert!(parsed
        .text
        .starts_with("\u{267b}\u{fe0f} Recovered reply\n"));
}

#[test]
fn sqlite_dedupe_media() {
    let home = tempfile::tempdir().expect("tempdir");
    let mut ledger = DeliveryLedger::sqlite(home.path().to_str().unwrap()).unwrap();
    let row = ledger
        .begin(
            SESSION,
            PLATFORM,
            CHAT,
            &OutboundPayload {
                text: "pic".to_string(),
                media_path: Some("/tmp/a.png".to_string()),
                explicit_media: None,
            },
        )
        .unwrap();

    // pending -> not deduped
    assert!(!ledger.dedupe_media(SESSION, "/tmp/a.png", false).unwrap());
    // explicit -> never deduped
    assert!(!ledger.dedupe_media(SESSION, "/tmp/a.png", true).unwrap());

    ledger.ack(&row.row_id).unwrap();
    assert!(ledger.dedupe_media(SESSION, "/tmp/a.png", false).unwrap());
    // other session / other path -> not deduped
    assert!(!ledger.dedupe_media("other", "/tmp/a.png", false).unwrap());
    assert!(!ledger.dedupe_media(SESSION, "/tmp/b.png", false).unwrap());
}

#[test]
fn sqlite_delivery_state_round_trips_as_lowercase() {
    for s in ["pending", "sending", "delivered", "failed"] {
        assert_eq!(DeliveryState::from_str(s).unwrap().as_str(), s);
    }
}
