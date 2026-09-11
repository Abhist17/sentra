//! Sentra — on-chain risk snapshots for Solana wallets.
//!
//! The engine computes a 0–100 risk score for every wallet it monitors. This
//! program lets it anchor those scores on-chain as immutable, timestamped
//! snapshots, so a claim like "this wallet scored 72 at 14:03 on Tuesday" is
//! verifiable by anyone rather than trusted.
//!
//! Two roles:
//!
//!   REPORTER — whoever signs and pays for a snapshot. The engine. A snapshot
//!   permanently records which reporter wrote it, so a verifier decides whose
//!   model they trust by checking one key, and two reporters can never collide
//!   on the same wallet and second.
//!
//!   OWNER — the wallet being scored. Owners never need to do anything. They
//!   MAY register a preference: the score they consider a breach, and the one
//!   reporter they trust to judge it. Only that reporter's snapshots then emit
//!   a `breached` event for the wallet, which is what an on-chain consumer
//!   should subscribe to.
//!
//! v1 of this program only let a wallet score itself, which meant the engine
//! could anchor exactly one wallet: its own. This is the v2 redesign.

use anchor_lang::prelude::*;

declare_id!("6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj");

/// A snapshot's timestamp is supplied by the client so the PDA is derivable
/// off-chain before the write. It is still checked against the cluster clock:
/// without this, any caller could mint unlimited snapshot accounts at
/// arbitrary timestamps, including ones that rewrite a wallet's history.
pub const MAX_CLOCK_DRIFT_SECONDS: i64 = 15 * 60;

pub const MAX_RISK_SCORE: u8 = 100;
pub const MAX_THRESHOLD: u8 = 100;

#[program]
pub mod sentra {
    use super::*;

    // -----------------------------------
    // Owner: register a risk preference
    // -----------------------------------
    /// Creates the caller's preference PDA. `reporter` is the key whose
    /// snapshots are allowed to declare a breach against this wallet.
    pub fn initialize_preferences(
        ctx: Context<InitializePreferences>,
        threshold: u8,
        reporter: Pubkey,
    ) -> Result<()> {
        require!(threshold <= MAX_THRESHOLD, SentraError::InvalidThreshold);

        let pref = &mut ctx.accounts.preference;
        pref.owner = ctx.accounts.owner.key();
        pref.threshold = threshold;
        pref.reporter = reporter;
        pref.updated_at = Clock::get()?.unix_timestamp;
        pref.bump = ctx.bumps.preference;

        Ok(())
    }

    // -----------------------------------
    // Owner: change threshold or reporter
    // -----------------------------------
    pub fn update_preferences(
        ctx: Context<UpdatePreferences>,
        threshold: u8,
        reporter: Pubkey,
    ) -> Result<()> {
        require!(threshold <= MAX_THRESHOLD, SentraError::InvalidThreshold);

        let pref = &mut ctx.accounts.preference;
        pref.threshold = threshold;
        pref.reporter = reporter;
        pref.updated_at = Clock::get()?.unix_timestamp;

        Ok(())
    }

    // -----------------------------------
    // Reporter: anchor a score
    // -----------------------------------
    /// Writes an immutable snapshot of `wallet`'s risk score at `timestamp`.
    ///
    /// The reporter signs and pays. When the wallet's owner has registered a
    /// preference, it is passed in read-only and the event says whether the
    /// score breaches their threshold; when they have not, the event still
    /// fires with no threshold attached.
    pub fn record_risk_score(
        ctx: Context<RecordRiskScore>,
        wallet: Pubkey,
        risk_score: u8,
        timestamp: i64,
    ) -> Result<()> {
        require!(risk_score <= MAX_RISK_SCORE, SentraError::InvalidRiskScore);

        let now = Clock::get()?.unix_timestamp;
        require!(
            (timestamp - now).abs() <= MAX_CLOCK_DRIFT_SECONDS,
            SentraError::TimestampOutOfRange
        );

        let reporter = ctx.accounts.reporter.key();

        let snapshot = &mut ctx.accounts.snapshot;
        snapshot.wallet = wallet;
        snapshot.reporter = reporter;
        snapshot.risk_score = risk_score;
        snapshot.timestamp = timestamp;
        snapshot.bump = ctx.bumps.snapshot;

        // A breach is the event worth subscribing to — flag it explicitly
        // rather than making every listener re-derive it. It can only be
        // declared by the reporter the owner named, which the account
        // constraint below enforces before this code runs.
        let threshold = ctx.accounts.preference.as_ref().map(|p| p.threshold);
        let breached = threshold.map_or(false, |t| risk_score >= t);

        emit!(RiskScoreRecorded {
            wallet,
            reporter,
            risk_score,
            threshold,
            breached,
            timestamp,
        });

        Ok(())
    }

    // -----------------------------------
    // Reporter: reclaim a snapshot's rent
    // -----------------------------------
    // Every snapshot rents a fresh account forever. Without a way to close
    // them, a wallet anchored on a short interval leaks rent indefinitely.
    pub fn close_snapshot(_ctx: Context<CloseSnapshot>) -> Result<()> {
        Ok(())
    }
}

//
// ----------------------------
// Accounts
// ----------------------------
//

#[derive(Accounts)]
pub struct InitializePreferences<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + RiskPreference::INIT_SPACE,
        seeds = [RiskPreference::SEED, owner.key().as_ref()],
        bump
    )]
    pub preference: Account<'info, RiskPreference>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePreferences<'info> {
    // The seeds bind this PDA to the signer, so a non-owner cannot even
    // produce the right address — the authorisation check is the address.
    #[account(
        mut,
        seeds = [RiskPreference::SEED, owner.key().as_ref()],
        bump = preference.bump,
    )]
    pub preference: Account<'info, RiskPreference>,

    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey, risk_score: u8, timestamp: i64)]
pub struct RecordRiskScore<'info> {
    // Seeded by reporter AND wallet: each reporter keeps its own series per
    // wallet, so nobody can front-run a slot and block another reporter's
    // write, and a verifier can fetch exactly one reporter's history.
    #[account(
        init,
        payer = reporter,
        space = 8 + RiskSnapshot::INIT_SPACE,
        seeds = [
            RiskSnapshot::SEED,
            reporter.key().as_ref(),
            wallet.as_ref(),
            &timestamp.to_le_bytes()
        ],
        bump
    )]
    pub snapshot: Account<'info, RiskSnapshot>,

    // The scored wallet's preference, if its owner registered one. Read-only:
    // a reporter must never be able to edit an owner's settings. The seeds
    // tie it to `wallet`, and the constraint refuses any reporter the owner
    // did not name — an unnamed reporter can still anchor a score, it just
    // cannot invoke the owner's threshold to call it a breach.
    #[account(
        seeds = [RiskPreference::SEED, wallet.as_ref()],
        bump = preference.bump,
        constraint = preference.reporter == reporter.key() @ SentraError::UnauthorizedReporter,
    )]
    pub preference: Option<Account<'info, RiskPreference>>,

    #[account(mut)]
    pub reporter: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseSnapshot<'info> {
    // Seeded by the signer, so only the reporter that paid for a snapshot can
    // close it and take the rent back.
    #[account(
        mut,
        close = reporter,
        seeds = [
            RiskSnapshot::SEED,
            reporter.key().as_ref(),
            snapshot.wallet.as_ref(),
            &snapshot.timestamp.to_le_bytes()
        ],
        bump = snapshot.bump,
    )]
    pub snapshot: Account<'info, RiskSnapshot>,

    #[account(mut)]
    pub reporter: Signer<'info>,
}

//
// ----------------------------
// Data Structures
// ----------------------------
//

/// A wallet owner's alert settings. One per wallet, owner-controlled.
#[account]
#[derive(InitSpace)]
pub struct RiskPreference {
    pub owner: Pubkey,
    /// Score at or above which a snapshot counts as a breach.
    pub threshold: u8,
    /// The only reporter allowed to declare a breach for this wallet.
    pub reporter: Pubkey,
    pub updated_at: i64,
    // Storing the bump lets every later instruction verify the PDA without
    // paying to re-derive it.
    pub bump: u8,
}

impl RiskPreference {
    pub const SEED: &'static [u8] = b"risk_preference";
}

/// One immutable reading: this wallet scored this much at this second,
/// according to this reporter.
#[account]
#[derive(InitSpace)]
pub struct RiskSnapshot {
    pub wallet: Pubkey,
    pub reporter: Pubkey,
    pub risk_score: u8,
    pub timestamp: i64,
    pub bump: u8,
}

impl RiskSnapshot {
    pub const SEED: &'static [u8] = b"risk_snapshot";
}

//
// ----------------------------
// Events
// ----------------------------
//

#[event]
pub struct RiskScoreRecorded {
    pub wallet: Pubkey,
    pub reporter: Pubkey,
    pub risk_score: u8,
    /// The owner's threshold when they have registered one and named this
    /// reporter; otherwise absent, and `breached` is false.
    pub threshold: Option<u8>,
    pub breached: bool,
    pub timestamp: i64,
}

#[error_code]
pub enum SentraError {
    #[msg("Threshold must be between 0 and 100")]
    InvalidThreshold,

    #[msg("Risk score must be between 0 and 100")]
    InvalidRiskScore,

    #[msg("Timestamp is too far from the cluster clock")]
    TimestampOutOfRange,

    #[msg("This reporter is not the one the wallet owner named")]
    UnauthorizedReporter,
}
