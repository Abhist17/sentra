use anchor_lang::prelude::*;

declare_id!("73SS3HB4KTFDWkPkY68FHd3eSpEAqCLpej71ebGAUujA");

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
        require!(threshold <= 100, ErrorCode::InvalidThreshold);

        let pref = &mut ctx.accounts.preference;

        pref.owner = ctx.accounts.user.key();
        pref.threshold = threshold;
        pref.last_risk_score = 0;
        pref.last_updated = Clock::get()?.unix_timestamp;

        Ok(())
    }

    // -----------------------------------
    // Update Threshold
    // -----------------------------------
    pub fn update_threshold(
        ctx: Context<UpdateThreshold>,
        new_threshold: u8,
    ) -> Result<()> {
        require!(new_threshold <= 100, ErrorCode::InvalidThreshold);

        let pref = &mut ctx.accounts.preference;

        require!(
            pref.owner == ctx.accounts.user.key(),
            ErrorCode::Unauthorized
        );

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
    require!(risk_score <= 100, ErrorCode::InvalidRiskScore);

    let pref = &mut ctx.accounts.preference;

    pref.last_risk_score = risk_score;
    pref.last_updated = timestamp;

    let snapshot = &mut ctx.accounts.snapshot;
    snapshot.owner = pref.owner;
    snapshot.risk_score = risk_score;
    snapshot.timestamp = timestamp;

    emit!(RiskAlertEvent {
        owner: pref.owner,
        risk_score,
        threshold: pref.threshold,
        timestamp,
    });

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
        space = 8 + 32 + 1 + 1 + 8,
        seeds = [b"risk_preference", user.key().as_ref()],
        bump
    )]
    pub preference: Account<'info, RiskPreference>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateThreshold<'info> {
    #[account(
        mut,
        seeds = [b"risk_preference", user.key().as_ref()],
        bump
    )]
    pub preference: Account<'info, RiskPreference>,

    pub user: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(risk_score: u8, timestamp: i64)]
pub struct RecordRiskScore<'info> {
    #[account(
        mut,
        seeds = [b"risk_preference", user.key().as_ref()],
        bump
    )]
    pub preference: Account<'info, RiskPreference>,

    #[account(
        init,
        payer = user,
        space = 8 + 32 + 1 + 8,
        seeds = [
            b"risk_snapshot",
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


//
// ----------------------------
// Data Structures
// ----------------------------
//

#[account]
pub struct RiskPreference {
    pub owner: Pubkey,
    pub threshold: u8,
    pub last_risk_score: u8,
    pub last_updated: i64,
}

#[account]
pub struct RiskSnapshot {
    pub owner: Pubkey,
    pub risk_score: u8,
    pub timestamp: i64,
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
    pub timestamp: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Threshold must be between 0 and 100")]
    InvalidThreshold,

    #[msg("Unauthorized access")]
    Unauthorized,

    #[msg("Risk score must be between 0 and 100")]
    InvalidRiskScore,
}
