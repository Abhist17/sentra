use anchor_lang::prelude::*;

declare_id!("3hvd91mHEs4ujsWkRAaGLzkvY7VTNwpaD79is2YFZrma");

#[program]
pub mod sentra {
    use super::*;

    pub fn initialize_preferences(
        ctx: Context<InitializePreferences>,
        threshold: u8,
    ) -> Result<()> {
        require!(threshold <= 100, ErrorCode::InvalidThreshold);

        let preference = &mut ctx.accounts.preference;
        preference.owner = ctx.accounts.user.key();
        preference.threshold = threshold;
        preference.created_at = Clock::get()?.unix_timestamp;
        preference.updated_at = Clock::get()?.unix_timestamp;

        Ok(())
    }

    pub fn update_threshold(
        ctx: Context<UpdateThreshold>,
        new_threshold: u8,
    ) -> Result<()> {
        require!(new_threshold <= 100, ErrorCode::InvalidThreshold);

        let preference = &mut ctx.accounts.preference;

        require!(
            preference.owner == ctx.accounts.user.key(),
            ErrorCode::Unauthorized
        );

        preference.threshold = new_threshold;
        preference.updated_at = Clock::get()?.unix_timestamp;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePreferences<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 1 + 8 + 8,
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

    #[account(mut)]
    pub user: Signer<'info>,
}

#[account]
pub struct RiskPreference {
    pub owner: Pubkey,
    pub threshold: u8,
    pub created_at: i64,
    pub updated_at: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Threshold must be between 0 and 100")]
    InvalidThreshold,

    #[msg("Unauthorized access")]
    Unauthorized,
}
