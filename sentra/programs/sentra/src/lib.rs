use anchor_lang::prelude::*;

declare_id!("35PirCKfyFFPYR3nLUGmpTs8YRyhfz9CAUpHVwVhiLi4");

/// A snapshot's timestamp is supplied by the client so the PDA is derivable
/// off-chain before the write. It is still checked against the cluster clock:
/// without this, any caller could mint unlimited snapshot accounts at
/// arbitrary timestamps, including ones that overwrite the chart's history.
pub const MAX_CLOCK_DRIFT_SECONDS: i64 = 15 * 60;

pub const MAX_RISK_SCORE: u8 = 100;
pub const MAX_THRESHOLD: u8 = 100;

#[program]
pub mod sentra {
    use super::*;

    // -----------------------------------
    // Initialize User Risk Preference
    // -----------------------------------
    pub fn initialize_preferences(
        ctx: Context<InitializePreferences>,
        threshold: u8,
    ) -> Result<()> {
        require!(threshold <= MAX_THRESHOLD, SentraError::InvalidThreshold);

        let pref = &mut ctx.accounts.preference;

        pref.owner = ctx.accounts.user.key();
        pref.threshold = threshold;
        pref.last_risk_score = 0;
        pref.last_updated = Clock::get()?.unix_timestamp;
        pref.bump = ctx.bumps.preference;

        Ok(())
    }

    // -----------------------------------
    // Update Threshold
    // -----------------------------------
    pub fn update_threshold(ctx: Context<UpdateThreshold>, new_threshold: u8) -> Result<()> {
        require!(
            new_threshold <= MAX_THRESHOLD,
            SentraError::InvalidThreshold
        );

        let pref = &mut ctx.accounts.preference;
        pref.threshold = new_threshold;
        pref.last_updated = Clock::get()?.unix_timestamp;

        Ok(())
    }

    // -----------------------------------
    // Store Risk Score + Create Snapshot
    // -----------------------------------
    pub fn record_risk_score(
        ctx: Context<RecordRiskScore>,
        risk_score: u8,
        timestamp: i64,
    ) -> Result<()> {
        require!(risk_score <= MAX_RISK_SCORE, SentraError::InvalidRiskScore);

        let now = Clock::get()?.unix_timestamp;
        require!(
            (timestamp - now).abs() <= MAX_CLOCK_DRIFT_SECONDS,
            SentraError::TimestampOutOfRange
        );

        let pref = &mut ctx.accounts.preference;
        pref.last_risk_score = risk_score;
        pref.last_updated = timestamp;

        let snapshot = &mut ctx.accounts.snapshot;
        snapshot.owner = pref.owner;
        snapshot.risk_score = risk_score;
        snapshot.timestamp = timestamp;
        snapshot.bump = ctx.bumps.snapshot;

        // A breach is the event worth subscribing to — flag it explicitly
        // rather than making every listener re-derive it.
        emit!(RiskAlertEvent {
            owner: pref.owner,
            risk_score,
            threshold: pref.threshold,
            breached: risk_score >= pref.threshold,
            timestamp,
        });

        Ok(())
    }

    // -----------------------------------
    // Close a Snapshot (reclaim rent)
    // -----------------------------------
    // Every snapshot rents a fresh account forever. Without a way to close
    // them, a wallet monitored on a 30s interval leaks rent indefinitely.
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
        payer = user,
        space = 8 + RiskPreference::INIT_SPACE,
        seeds = [RiskPreference::SEED, user.key().as_ref()],
        bump
    )]
    pub preference: Account<'info, RiskPreference>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateThreshold<'info> {
    // The seeds bind this PDA to the signer, so a non-owner cannot even
    // produce the right address. That replaces the old in-handler
    // `pref.owner == user.key()` check, which ran only after the account had
    // already been loaded as `mut`.
    #[account(
        mut,
        seeds = [RiskPreference::SEED, user.key().as_ref()],
        bump = preference.bump,
    )]
    pub preference: Account<'info, RiskPreference>,

    pub user: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(risk_score: u8, timestamp: i64)]
pub struct RecordRiskScore<'info> {
    #[account(
        mut,
        seeds = [RiskPreference::SEED, user.key().as_ref()],
        bump = preference.bump,
    )]
    pub preference: Account<'info, RiskPreference>,

    #[account(
        init,
        payer = user,
        space = 8 + RiskSnapshot::INIT_SPACE,
        seeds = [
            RiskSnapshot::SEED,
            user.key().as_ref(),
            &timestamp.to_le_bytes()
        ],
        bump
    )]
    pub snapshot: Account<'info, RiskSnapshot>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseSnapshot<'info> {
    // Seeded by the signer, so only the wallet that created a snapshot can
    // close it and reclaim its rent.
    #[account(
        mut,
        close = user,
        seeds = [
            RiskSnapshot::SEED,
            user.key().as_ref(),
            &snapshot.timestamp.to_le_bytes()
        ],
        bump = snapshot.bump,
    )]
    pub snapshot: Account<'info, RiskSnapshot>,

    #[account(mut)]
    pub user: Signer<'info>,
}

//
// ----------------------------
// Data Structures
// ----------------------------
//

#[account]
#[derive(InitSpace)]
pub struct RiskPreference {
    pub owner: Pubkey,
    pub threshold: u8,
    pub last_risk_score: u8,
    pub last_updated: i64,
    // Storing the bump lets every later instruction verify the PDA without
    // paying to re-derive it.
    pub bump: u8,
}

impl RiskPreference {
    pub const SEED: &'static [u8] = b"risk_preference";
}

#[account]
#[derive(InitSpace)]
pub struct RiskSnapshot {
    pub owner: Pubkey,
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
pub struct RiskAlertEvent {
    pub owner: Pubkey,
    pub risk_score: u8,
    pub threshold: u8,
    pub breached: bool,
    pub timestamp: i64,
}

#[error_code]
pub enum SentraError {
    #[msg("Threshold must be between 0 and 100")]
    InvalidThreshold,

    #[msg("Unauthorized access")]
    Unauthorized,

    #[msg("Risk score must be between 0 and 100")]
    InvalidRiskScore,

    #[msg("Timestamp is too far from the cluster clock")]
    TimestampOutOfRange,
}
